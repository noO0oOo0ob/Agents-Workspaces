import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter, AgentAdapterHooks, AgentSessionHandle, StartAgentInput } from "@agents-workspaces/agent-core";
import type { ProcessHandle } from "@agents-workspaces/executor-core";
import {
  buildClaudeCodeUserMessage,
  claudeCodeInteractionEvent,
  ClaudeCodeEventAdapter,
  parseClaudeCodeHook,
} from "@agents-workspaces/ag-ui-claude-code";

const execFileAsync = promisify(execFile);

interface ClaudeRuntime {
  input: StartAgentInput;
  process: ProcessHandle;
  providerSessionId: string;
  stdoutBuffer: string;
  events: ClaudeCodeEventAdapter;
}

function streamUserMessage(message: string): string {
  return `${buildClaudeCodeUserMessage(message)}\n`;
}

export async function writeClaudeHookSettings(workspacePath: string, gatewayUrl: string, sessionId: string): Promise<string> {
  const directory = join(workspacePath, ".agents-workspaces");
  await mkdir(directory, { recursive: true });
  const url = `${gatewayUrl.replace(/\/$/, "")}/api/hooks/claude?sessionId=${encodeURIComponent(sessionId)}`;
  const httpHook = {
    type: "http", url, timeout: 86_400,
    headers: { Authorization: "Bearer $AGENTS_WORKSPACES_HOOK_TOKEN" },
    allowedEnvVars: ["AGENTS_WORKSPACES_HOOK_TOKEN"],
  };
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [httpHook] }],
      PermissionRequest: [{ matcher: ".*", hooks: [httpHook] }],
      Elicitation: [{ matcher: ".*", hooks: [httpHook] }],
      Stop: [{ matcher: ".*", hooks: [{ ...httpHook, timeout: 10 }] }],
      SessionEnd: [{ matcher: ".*", hooks: [{ ...httpHook, timeout: 10 }] }],
    },
  };
  const path = join(directory, "claude-settings.json");
  await writeFile(path, JSON.stringify(settings, null, 2), "utf8");
  return path;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = "claude" as const;
  readonly #hooks: AgentAdapterHooks;
  readonly #sessions = new Map<string, ClaudeRuntime>();

  constructor(hooks: AgentAdapterHooks) { this.#hooks = hooks; }

  isRunning(sessionId: string): boolean { return this.#sessions.has(sessionId); }

  async checkInstallation(): Promise<{ installed: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await execFileAsync("claude", ["--version"], { encoding: "utf8" });
      return { installed: true, version: stdout.trim() };
    } catch (error) {
      return { installed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async start(input: StartAgentInput): Promise<AgentSessionHandle> {
    const providerSessionId = input.providerSessionId ?? randomUUID();
    const settingsPath = await writeClaudeHookSettings(input.workspacePath, input.gatewayUrl, input.sessionId);
    const settingsArgument = input.executor.type === "docker" ? "/workspace/.agents-workspaces/claude-settings.json" : settingsPath;
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--include-hook-events",
      "--replay-user-messages",
      "--permission-mode", "manual",
      "--settings", settingsArgument,
    ];
    if (input.providerSessionId) args.push("--resume", input.providerSessionId);
    else args.push("--session-id", providerSessionId);

    const process = await input.executor.spawn({
      sessionId: input.sessionId,
      provider: "claude",
      command: "claude",
      args,
      cwd: input.workspacePath,
      ...(input.image ? { image: input.image } : {}),
      env: {
        ...input.environment,
        ...(input.hookToken ? { AGENTS_WORKSPACES_HOOK_TOKEN: input.hookToken } : {}),
      },
    });
    const runtime: ClaudeRuntime = {
      input,
      process,
      providerSessionId,
      stdoutBuffer: "",
      events: new ClaudeCodeEventAdapter({ threadId: providerSessionId, runId: input.sessionId }),
    };
    this.#sessions.set(input.sessionId, runtime);
    process.onOutput((stream, data) => {
      if (stream === "stderr") this.#emit(runtime, "session.log", { stream, data });
      else this.#consume(runtime, data);
    });
    process.onExit((exit) => {
      this.#emit(runtime, exit.code === 0 ? "session.ended" : "session.failed", exit);
      this.#sessions.delete(input.sessionId);
    });
    process.write(streamUserMessage(input.prompt));
    this.#emit(runtime, "session.started", { providerSessionId });
    return { sessionId: input.sessionId, providerSessionId, provider: "claude" };
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const runtime = this.#required(sessionId);
    runtime.events.setContext({ runId: randomUUID() });
    runtime.process.write(streamUserMessage(message));
  }

  async interrupt(sessionId: string): Promise<void> { this.#required(sessionId).process.interrupt(); }
  async terminate(sessionId: string): Promise<void> { this.#required(sessionId).process.terminate(); }

  #consume(runtime: ClaudeRuntime, chunk: string): void {
    runtime.stdoutBuffer += chunk;
    let newline = runtime.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = runtime.stdoutBuffer.slice(0, newline).trim();
      runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newline + 1);
      if (line) {
        try { this.#handle(runtime, JSON.parse(line) as Record<string, unknown>); }
        catch (error) { this.#emit(runtime, "session.log", { stream: "stderr", data: `Invalid Claude stream JSON: ${String(error)}` }); }
      }
      newline = runtime.stdoutBuffer.indexOf("\n");
    }
  }

  #handle(runtime: ClaudeRuntime, message: Record<string, unknown>): void {
    if (message.type === "system" && typeof message.session_id === "string") {
      runtime.providerSessionId = message.session_id;
      runtime.events.setContext({ threadId: runtime.providerSessionId });
    }
    for (const event of runtime.events.adapt(message)) this.#emit(runtime, event.type, event);
  }

  #required(sessionId: string): ClaudeRuntime {
    const runtime = this.#sessions.get(sessionId);
    if (!runtime) throw new Error(`Claude session is not running: ${sessionId}`);
    return runtime;
  }

  #emit(runtime: ClaudeRuntime, type: string, payload: unknown): void {
    this.#hooks.emit({ type, taskId: runtime.input.taskId, sessionId: runtime.input.sessionId, provider: "claude", payload });
  }
}

export const claudeAdapterMetadata = {
  provider: "claude", transports: ["stream-json", "http-hooks", "mcp-bridge"],
  supportedInteractions: ["command_approval", "permission_request", "question", "form"],
} as const;

export { claudeCodeInteractionEvent, parseClaudeCodeHook };
