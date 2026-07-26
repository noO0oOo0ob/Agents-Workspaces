import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentAdapter,
  AgentAdapterHooks,
  AgentSessionHandle,
  StartAgentInput,
} from "@agents-workspaces/agent-core";
import type { ProcessHandle } from "@agents-workspaces/executor-core";

const execFileAsync = promisify(execFile);

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface CodexRuntime {
  input: StartAgentInput;
  process: ProcessHandle;
  threadId: string;
  turnId: string | null;
  sequence: number;
  pending: Map<string | number, { resolve(value: unknown): void; reject(error: Error): void }>;
  stdoutBuffer: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex" as const;
  readonly #hooks: AgentAdapterHooks;
  readonly #sessions = new Map<string, CodexRuntime>();

  constructor(hooks: AgentAdapterHooks) { this.#hooks = hooks; }

  async checkInstallation(): Promise<{ installed: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await execFileAsync("codex", ["--version"], { encoding: "utf8" });
      return { installed: true, version: stdout.trim() };
    } catch (error) {
      return { installed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async start(input: StartAgentInput): Promise<AgentSessionHandle> {
    const process = await input.executor.spawn({
      sessionId: input.sessionId,
      provider: "codex",
      command: "codex",
      args: ["app-server", "--stdio"],
      cwd: input.workspacePath,
      ...(input.image ? { image: input.image } : {}),
      ...(input.environment ? { env: input.environment } : {}),
    });
    const runtime: CodexRuntime = {
      input,
      process,
      threadId: input.providerSessionId ?? "",
      turnId: null,
      sequence: 0,
      pending: new Map(),
      stdoutBuffer: "",
    };
    this.#sessions.set(input.sessionId, runtime);
    process.onOutput((stream, data) => {
      if (stream === "stderr") {
        this.#emit(runtime, "session.log", { stream, data });
        return;
      }
      this.#consume(runtime, data);
    });
    process.onExit((exit) => {
      for (const waiter of runtime.pending.values()) waiter.reject(new Error("Codex App Server exited"));
      runtime.pending.clear();
      this.#emit(runtime, exit.code === 0 ? "session.ended" : "session.failed", exit);
      this.#sessions.delete(input.sessionId);
    });

    await this.#request(runtime, "initialize", {
      clientInfo: { name: "agents-workspaces", title: "Agents-Workspaces", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    this.#notify(runtime, "initialized", {});
    const threadResult = asRecord(await this.#request(runtime, input.providerSessionId ? "thread/resume" : "thread/start", input.providerSessionId
      ? { threadId: input.providerSessionId, cwd: input.workspacePath, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" }
      : { cwd: input.workspacePath, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", ephemeral: false }));
    const thread = asRecord(threadResult.thread);
    runtime.threadId = String(thread.id ?? input.providerSessionId ?? "");
    this.#emit(runtime, "session.started", { providerSessionId: runtime.threadId });
    await this.#startTurn(runtime, input.prompt);
    return { sessionId: input.sessionId, providerSessionId: runtime.threadId, provider: "codex" };
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const runtime = this.#required(sessionId);
    if (runtime.turnId) {
      await this.#request(runtime, "turn/steer", {
        threadId: runtime.threadId,
        expectedTurnId: runtime.turnId,
        input: [{ type: "text", text: message, text_elements: [] }],
      });
    } else {
      await this.#startTurn(runtime, message);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.#required(sessionId);
    if (runtime.turnId) await this.#request(runtime, "turn/interrupt", { threadId: runtime.threadId, turnId: runtime.turnId });
  }

  async terminate(sessionId: string): Promise<void> { this.#required(sessionId).process.terminate(); }

  async #startTurn(runtime: CodexRuntime, prompt: string): Promise<void> {
    const result = asRecord(await this.#request(runtime, "turn/start", {
      threadId: runtime.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: runtime.input.workspacePath,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite", writableRoots: [runtime.input.workspacePath], networkAccess: true,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
    }));
    const turn = asRecord(result.turn);
    runtime.turnId = typeof turn.id === "string" ? turn.id : runtime.turnId;
  }

  #request(runtime: CodexRuntime, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++runtime.sequence;
    runtime.process.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => runtime.pending.set(id, { resolve, reject }));
  }

  #notify(runtime: CodexRuntime, method: string, params: Record<string, unknown>): void {
    runtime.process.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  #consume(runtime: CodexRuntime, chunk: string): void {
    runtime.stdoutBuffer += chunk;
    let newline = runtime.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = runtime.stdoutBuffer.slice(0, newline).trim();
      runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcMessage;
          void this.#handle(runtime, message).catch((error) => {
            this.#emit(runtime, "session.error", { message: error instanceof Error ? error.message : String(error) });
            if (message.id !== undefined && message.method) {
              runtime.process.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`);
            }
          });
        }
        catch (error) { this.#emit(runtime, "session.log", { stream: "stderr", data: `Invalid Codex JSON-RPC: ${String(error)}` }); }
      }
      newline = runtime.stdoutBuffer.indexOf("\n");
    }
  }

  async #handle(runtime: CodexRuntime, message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined && !message.method) {
      const pending = runtime.pending.get(message.id);
      if (!pending) return;
      runtime.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex JSON-RPC error"));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    if (message.id !== undefined) {
      const response = await this.#handleServerRequest(runtime, message);
      runtime.process.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\n`);
      return;
    }
    const params = message.params ?? {};
    if (message.method === "turn/started") runtime.turnId = String(asRecord(params.turn).id ?? runtime.turnId ?? "");
    if (message.method === "turn/completed") {
      runtime.turnId = null;
      this.#emit(runtime, "turn.completed", params);
    } else if (message.method === "item/agentMessage/delta") {
      this.#emit(runtime, "message.delta", params);
    } else if (message.method === "item/started") {
      this.#emit(runtime, "tool.started", params);
    } else if (message.method === "item/completed") {
      this.#emit(runtime, "tool.completed", params);
    } else if (message.method === "error") {
      this.#emit(runtime, "session.error", params);
    } else {
      this.#emit(runtime, "provider.event", { method: message.method, params });
    }
  }

  async #handleServerRequest(runtime: CodexRuntime, message: JsonRpcMessage): Promise<Record<string, unknown>> {
    const params = message.params ?? {};
    const providerRequestId = String(message.id);
    if (message.method === "item/commandExecution/requestApproval") {
      return this.#hooks.requestInteraction(runtime.input.sessionId, {
        providerRequestId, kind: "command_approval", title: "Approve command",
        message: typeof params.reason === "string" ? params.reason : undefined,
        riskLevel: "high", request: params,
        availableDecisions: Array.isArray(params.availableDecisions) ? params.availableDecisions.filter((x): x is string => typeof x === "string") : ["accept", "acceptForSession", "decline", "cancel"],
      });
    }
    if (message.method === "item/fileChange/requestApproval") {
      return this.#hooks.requestInteraction(runtime.input.sessionId, {
        providerRequestId, kind: "file_approval", title: "Approve file changes",
        message: typeof params.reason === "string" ? params.reason : undefined,
        riskLevel: "medium", request: params,
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      });
    }
    if (message.method === "item/permissions/requestApproval") {
      return this.#hooks.requestInteraction(runtime.input.sessionId, {
        providerRequestId, kind: "permission_request", title: "Grant additional permissions",
        message: typeof params.reason === "string" ? params.reason : undefined,
        riskLevel: "high", request: params, availableDecisions: ["accept", "decline"],
      });
    }
    if (message.method === "item/tool/requestUserInput") {
      return this.#hooks.requestInteraction(runtime.input.sessionId, {
        providerRequestId, kind: "question", title: "Agent needs your input",
        riskLevel: "low", request: params, availableDecisions: ["submit", "cancel"],
      });
    }
    if (message.method === "mcpServer/elicitation/request") {
      return this.#hooks.requestInteraction(runtime.input.sessionId, {
        providerRequestId, kind: "form", title: "Agent requested structured input",
        message: typeof params.message === "string" ? params.message : undefined,
        riskLevel: "low", request: params, availableDecisions: ["accept", "decline", "cancel"],
      });
    }
    return {};
  }

  #required(sessionId: string): CodexRuntime {
    const runtime = this.#sessions.get(sessionId);
    if (!runtime) throw new Error(`Codex session is not running: ${sessionId}`);
    return runtime;
  }

  #emit(runtime: CodexRuntime, type: string, payload: unknown): void {
    this.#hooks.emit({ type, taskId: runtime.input.taskId, sessionId: runtime.input.sessionId, provider: "codex", payload });
  }
}

export const codexAdapterMetadata = {
  provider: "codex", transport: "app-server-stdio-json-rpc",
  supportedInteractions: ["command_approval", "file_approval", "permission_request", "question", "form"],
} as const;
