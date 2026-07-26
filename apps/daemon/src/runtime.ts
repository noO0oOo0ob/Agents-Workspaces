import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ClaudeAdapter } from "@agents-workspaces/agent-claude";
import type { AdapterInteractionInput, AgentAdapter } from "@agents-workspaces/agent-core";
import { CodexAdapter } from "@agents-workspaces/agent-codex";
import {
  createId,
  deriveTaskStatus,
  now,
  type AgentEvent,
  type AgentProvider,
  type AgentSession,
  type ExecutionProfile,
  type InteractionRequest,
  type Project,
  type Repository,
  type Task,
  type Workspace,
  type WorkspaceRepository,
} from "@agents-workspaces/core";
import { AppDatabase, createDatabaseConfig } from "@agents-workspaces/database";
import { DockerExecutor } from "@agents-workspaces/executor-docker";
import { NativeExecutor } from "@agents-workspaces/executor-native";
import { writeCompiledContexts, type KnowledgeSourceInput } from "@agents-workspaces/knowledge-compiler";
import { createWorkspace, inspectChanges, removeWorkspaceWorktrees, resolveWorkspacePath, safeDirectoryName, validateGitRepository } from "@agents-workspaces/workspace-manager";

const execFileAsync = promisify(execFile);

export interface RuntimeConfig {
  host: string;
  listenHost: string;
  port: number;
  dataDirectory: string;
  workspaceRoot: string;
  obsidianVault: string | null;
  publicDirectory: string | null;
  hookToken: string;
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    host: process.env.AGENTS_WORKSPACES_HOST ?? "127.0.0.1",
    listenHost: process.env.AGENTS_WORKSPACES_LISTEN_HOST ?? "0.0.0.0",
    port: Number(process.env.AGENTS_WORKSPACES_PORT ?? 4310),
    dataDirectory: expandHome(process.env.AGENTS_WORKSPACES_DATA_DIR ?? ".data"),
    workspaceRoot: expandHome(process.env.AGENTS_WORKSPACES_WORKSPACE_ROOT ?? "~/agents-workspaces"),
    obsidianVault: process.env.AGENTS_WORKSPACES_OBSIDIAN_VAULT ? expandHome(process.env.AGENTS_WORKSPACES_OBSIDIAN_VAULT) : null,
    publicDirectory: process.env.AGENTS_WORKSPACES_PUBLIC_DIR ? expandHome(process.env.AGENTS_WORKSPACES_PUBLIC_DIR) : null,
    hookToken: process.env.AGENTS_WORKSPACES_HOOK_TOKEN ?? randomBytes(32).toString("hex"),
  };
}

interface PendingInteraction {
  sessionId: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

export class AgentBoardRuntime {
  readonly db: AppDatabase;
  readonly config: RuntimeConfig;
  readonly #events = new EventEmitter();
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  readonly #native = new NativeExecutor();
  readonly #docker = new DockerExecutor();
  readonly #adapters: Record<AgentProvider, AgentAdapter>;

  constructor(config = loadRuntimeConfig()) {
    this.config = config;
    this.db = new AppDatabase(createDatabaseConfig(config.dataDirectory).filePath);
    const hooks = {
      emit: (event: Omit<AgentEvent, "id" | "occurredAt" | "schemaVersion">) => this.emit(event),
      requestInteraction: (sessionId: string, input: AdapterInteractionInput) => this.requestInteraction(sessionId, input),
    };
    this.#adapters = { codex: new CodexAdapter(hooks), claude: new ClaudeAdapter(hooks) };
    for (const session of this.db.recoverInterruptedSessions(now())) {
      this.db.setTaskStatus(session.taskId, "in_review", now());
    }
  }

  close(): void { this.db.close(); }

  subscribe(listener: (event: AgentEvent & { sequence: number }) => void): () => void {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  emit(input: Omit<AgentEvent, "id" | "occurredAt" | "schemaVersion">): AgentEvent & { sequence: number } {
    const event: AgentEvent = { ...input, id: createId("evt"), occurredAt: now(), schemaVersion: 1 };
    const sequence = this.db.insertEvent(event);
    const sequenced = { ...event, sequence };
    this.#applyEventState(event);
    this.#events.emit("event", sequenced);
    return sequenced;
  }

  createProject(input: Pick<Project, "name" | "description">): Project {
    const at = now();
    return this.db.insertProject({ id: createId("project"), ...input, createdAt: at, updatedAt: at });
  }

  async createRepository(projectId: string, input: { name: string; localPath?: string | null; remoteUrl?: string | null; baseBranch: string }): Promise<Repository> {
    if (!this.db.getProject(projectId)) throw new Error("Project not found");
    let localPath: string;
    if (input.localPath) {
      localPath = await validateGitRepository(resolve(input.localPath));
    } else if (input.remoteUrl) {
      const cacheRoot = join(this.config.dataDirectory, "repositories", projectId);
      await mkdir(cacheRoot, { recursive: true });
      localPath = join(cacheRoot, safeDirectoryName(input.name));
      await execFileAsync("git", ["clone", input.remoteUrl, localPath], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
      localPath = await validateGitRepository(localPath);
    } else {
      throw new Error("Either localPath or remoteUrl is required");
    }
    const at = now();
    const repository = this.db.insertRepository({
      id: createId("repo"), projectId, name: input.name, localPath,
      remoteUrl: input.remoteUrl ?? null, baseBranch: input.baseBranch, createdAt: at, updatedAt: at,
    });
    this.emit({ type: "repository.created", taskId: null, sessionId: null, provider: null, payload: repository });
    return repository;
  }

  createTask(input: Pick<Task, "projectId" | "title" | "description">): Task {
    if (!this.db.getProject(input.projectId)) throw new Error("Project not found");
    const at = now();
    const task = this.db.insertTask({
      id: createId("task"), ...input, status: "todo", reviewRequired: false,
      createdAt: at, updatedAt: at, startedAt: null, completedAt: null, cancelledAt: null,
    });
    this.emit({ type: "task.created", taskId: task.id, sessionId: null, provider: null, payload: task });
    return task;
  }

  taskDetails(taskId: string): Record<string, unknown> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const workspace = this.db.getWorkspaceByTask(taskId);
    return {
      task,
      workspace,
      workspaceRepositories: workspace ? this.db.listWorkspaceRepositories(workspace.id) : [],
      sessions: this.db.listSessions(taskId),
      interactions: this.db.listInteractions(taskId),
    };
  }

  async createTaskWorkspace(taskId: string, repositoryIds: string[], options: { rootPath?: string; branchName?: string; fetch?: boolean; knowledgeSources?: KnowledgeSourceInput[] }): Promise<Workspace> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const existingWorkspace = this.db.getWorkspaceByTask(taskId);
    if (existingWorkspace && existingWorkspace.status !== "failed") throw new Error("Task already has a Workspace");
    const repositories = this.db.getRepositories(repositoryIds);
    if (repositories.length !== repositoryIds.length) throw new Error("One or more repositories were not found");
    if (repositories.some((repository) => repository.projectId !== task.projectId)) throw new Error("All repositories must belong to the task project");
    const at = now();
    // A retry must reuse the paths already recorded for the Workspace. Allowing new
    // values here would make the database point at a different directory/branch.
    const root = existingWorkspace
      ? resolve(existingWorkspace.rootPath, "..")
      : options.rootPath ? expandHome(options.rootPath) : this.config.workspaceRoot;
    const branch = existingWorkspace?.branchPrefix ?? options.branchName ?? `agent/${task.id}`;
    const workspace: Workspace = existingWorkspace
      ? { ...existingWorkspace, status: "creating", error: null, updatedAt: at }
      : {
          id: createId("workspace"), taskId, rootPath: resolveWorkspacePath(root, task.id), branchPrefix: branch,
          status: "creating", error: null, createdAt: at, updatedAt: at,
        };
    if (existingWorkspace) this.db.updateWorkspace(workspace.id, "creating", null, at);
    else this.db.insertWorkspace(workspace);
    this.emit({ type: "workspace.creating", taskId, sessionId: null, provider: null, payload: workspace });
    let created: Awaited<ReturnType<typeof createWorkspace>> | null = null;
    try {
      created = await createWorkspace({
        taskId: task.id,
        rootPath: root,
        fetch: options.fetch ?? false,
        repositories: repositories.map((repository) => ({
          repositoryId: repository.id,
          repositoryName: repository.name,
          repositoryPath: repository.localPath,
          directoryName: repository.name,
          baseBranch: repository.baseBranch,
          taskBranch: branch,
        })),
      });
      for (const worktree of created.worktrees) {
        const row: WorkspaceRepository = {
          id: createId("workspaceRepo"), workspaceId: workspace.id, repositoryId: worktree.repositoryId,
          branch: worktree.taskBranch, worktreePath: worktree.worktreePath, baseBranch: worktree.baseBranch, createdAt: now(),
        };
        this.db.insertWorkspaceRepository(row);
      }
      if (options.knowledgeSources?.length) await writeCompiledContexts(created.workspacePath, options.knowledgeSources);
      this.db.updateWorkspace(workspace.id, "ready", null, now());
      this.emit({ type: "workspace.ready", taskId, sessionId: null, provider: null, payload: { ...workspace, status: "ready" } });
      return this.db.getWorkspaceByTask(taskId) as Workspace;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (created) {
        try {
          await removeWorkspaceWorktrees(created.worktrees.map((item) => ({
            repositoryPath: item.repositoryPath,
            worktreePath: item.worktreePath,
          })), true);
        } catch { /* keep the original error and leave paths visible for recovery */ }
      }
      this.db.deleteWorkspaceRepositories(workspace.id);
      this.db.updateWorkspace(workspace.id, "failed", message, now());
      this.emit({ type: "workspace.failed", taskId, sessionId: null, provider: null, payload: { error: message } });
      throw error;
    }
  }

  async taskChanges(taskId: string): Promise<unknown[]> {
    const workspace = this.db.getWorkspaceByTask(taskId);
    if (!workspace) throw new Error("Workspace not found");
    const worktrees = this.db.listWorkspaceRepositories(workspace.id);
    const repositories = this.db.getRepositories(worktrees.map((item) => item.repositoryId));
    const byId = new Map(repositories.map((repository) => [repository.id, repository]));
    return inspectChanges(worktrees.map((item) => ({
      repositoryId: item.repositoryId,
      repositoryName: byId.get(item.repositoryId)?.name ?? item.repositoryId,
      worktreePath: item.worktreePath,
      baseBranch: item.baseBranch,
    })));
  }

  async cleanupWorkspace(taskId: string, force = false): Promise<Workspace> {
    const workspace = this.db.getWorkspaceByTask(taskId);
    if (!workspace) throw new Error("Workspace not found");
    const links = this.db.listWorkspaceRepositories(workspace.id);
    const repositories = this.db.getRepositories(links.map((item) => item.repositoryId));
    const byId = new Map(repositories.map((repository) => [repository.id, repository]));
    await removeWorkspaceWorktrees(links.map((link) => {
      const repository = byId.get(link.repositoryId);
      if (!repository) throw new Error(`Repository not found: ${link.repositoryId}`);
      return { repositoryPath: repository.localPath, worktreePath: link.worktreePath };
    }), force);
    this.db.updateWorkspace(workspace.id, "archived", null, now());
    this.emit({ type: "workspace.archived", taskId, sessionId: null, provider: null, payload: { workspaceId: workspace.id } });
    return this.db.getWorkspaceByTask(taskId) as Workspace;
  }

  async saveKnowledgeCandidate(taskId: string, title: string, content: string): Promise<{ path: string }> {
    if (!this.config.obsidianVault) throw new Error("AGENTS_WORKSPACES_OBSIDIAN_VAULT is not configured");
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const directory = join(this.config.obsidianVault, "00 Inbox", "Agent Memory Candidates");
    await mkdir(directory, { recursive: true });
    const safeTitle = title.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, "-").slice(0, 80) || task.id;
    const path = join(directory, `${new Date().toISOString().slice(0, 10)}-${safeTitle}.md`);
    const markdown = `---\ntask_id: ${task.id}\nstatus: candidate\ncreated_at: ${now()}\n---\n\n# ${title}\n\n${content.trim()}\n`;
    await writeFile(path, markdown, { encoding: "utf8", flag: "wx" });
    this.emit({ type: "knowledge.candidate.saved", taskId, sessionId: null, provider: null, payload: { path } });
    return { path };
  }

  createExecutionProfile(input: Omit<ExecutionProfile, "id" | "createdAt" | "updatedAt">): ExecutionProfile {
    const at = now();
    return this.db.insertExecutionProfile({ id: createId("profile"), ...input, createdAt: at, updatedAt: at });
  }

  async profileHealth(profile: ExecutionProfile): Promise<Record<string, unknown>> {
    const executor = profile.type === "native" ? this.#native : this.#docker;
    const [executorHealth, agentHealth] = await Promise.all([
      executor.checkHealth(),
      profile.type === "docker"
        ? this.#docker.checkImage(profile.image ?? "agents-workspaces-runner:local", profile.provider)
        : this.#adapters[profile.provider].checkInstallation(),
    ]);
    const agentReady = "installed" in agentHealth ? agentHealth.installed : agentHealth.ready;
    return { executor: executorHealth, agent: agentHealth, ready: executorHealth.ready && agentReady };
  }

  async startSession(taskId: string, input: { provider: AgentProvider; executorType: "native" | "docker"; executionProfileId?: string; prompt: string; image?: string }): Promise<AgentSession> {
    const task = this.db.getTask(taskId);
    const workspace = this.db.getWorkspaceByTask(taskId);
    if (!task) throw new Error("Task not found");
    if (!workspace || workspace.status !== "ready") throw new Error("A ready Workspace is required");
    const profile = input.executionProfileId ? this.db.getExecutionProfile(input.executionProfileId) : null;
    if (profile && (profile.provider !== input.provider || profile.type !== input.executorType)) throw new Error("Execution Profile does not match provider/executor");
    const at = now();
    const session: AgentSession = {
      id: createId("session"), taskId, workspaceId: workspace.id, provider: input.provider,
      executorType: input.executorType, executionProfileId: profile?.id ?? null,
      providerSessionId: null, providerTurnId: null, runtimeStatus: "starting", prompt: input.prompt,
      summary: null, error: null, createdAt: at, updatedAt: at, endedAt: null,
    };
    this.db.insertSession(session);
    this.db.markTaskStarted(taskId, at);
    const executor = input.executorType === "native" ? this.#native : this.#docker;
    try {
      const handle = await this.#adapters[input.provider].start({
        sessionId: session.id, taskId, workspacePath: workspace.rootPath, prompt: input.prompt, executor,
        gatewayUrl: input.executorType === "docker" ? `http://host.docker.internal:${this.config.port}` : `http://${this.config.host}:${this.config.port}`,
        hookToken: this.config.hookToken,
        ...(profile?.image || input.image ? { image: profile?.image ?? input.image } : {}),
        ...(profile ? { environment: profile.environment } : {}),
      });
      this.db.updateSession(session.id, { runtimeStatus: "running", providerSessionId: handle.providerSessionId }, now());
      return this.db.getSession(session.id) as AgentSession;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateSession(session.id, { runtimeStatus: "failed", error: message, endedAt: now() }, now());
      this.db.setTaskStatus(taskId, "in_review", now());
      throw error;
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    this.db.updateSession(sessionId, { runtimeStatus: "running" }, now());
    this.db.setTaskStatus(session.taskId, "in_progress", now());
    await this.#adapters[session.provider].sendMessage(sessionId, message);
  }

  async interruptSession(sessionId: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    await this.#adapters[session.provider].interrupt(sessionId);
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    await this.#adapters[session.provider].terminate(sessionId);
    this.#rejectSessionInteractions(sessionId, new Error("Session was terminated"));
    this.db.staleSessionInteractions(sessionId, now());
  }

  async requestInteraction(sessionId: string, input: AdapterInteractionInput): Promise<Record<string, unknown>> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const interaction: InteractionRequest = {
      id: createId("interaction"), provider: session.provider, providerRequestId: input.providerRequestId,
      taskId: session.taskId, sessionId, kind: input.kind, title: input.title, message: input.message ?? null,
      riskLevel: input.riskLevel, request: input.request, availableDecisions: input.availableDecisions,
      status: "pending", response: null, createdAt: now(), respondedAt: null, resolvedAt: null,
    };
    this.db.insertInteraction(interaction);
    this.db.updateSession(sessionId, { runtimeStatus: "waiting" }, now());
    this.db.setTaskStatus(session.taskId, "needs_attention", now());
    this.emit({ type: "interaction.requested", taskId: session.taskId, sessionId, provider: session.provider, payload: interaction });
    this.#notify("Agents-Workspaces needs attention", interaction.title);
    return new Promise((resolve, reject) => this.#pendingInteractions.set(interaction.id, { sessionId, resolve, reject }));
  }

  respondInteraction(id: string, response: Record<string, unknown>): InteractionRequest {
    const interaction = this.db.getInteraction(id);
    if (!interaction) throw new Error("Interaction not found");
    if (interaction.status !== "pending") throw new Error("Interaction is no longer pending");
    const pending = this.#pendingInteractions.get(id);
    if (!pending) throw new Error("The Agent session is no longer connected; resume it before answering");
    const providerResponse = this.#providerResponse(interaction, response);
    this.db.respondInteraction(id, response, now());
    pending.resolve(providerResponse);
    this.#pendingInteractions.delete(id);
    this.db.resolveInteraction(id, now());
    this.db.updateSession(interaction.sessionId, { runtimeStatus: "running" }, now());
    this.#recomputeTaskStatus(interaction.taskId);
    this.emit({ type: "interaction.resolved", taskId: interaction.taskId, sessionId: interaction.sessionId, provider: interaction.provider, payload: { interactionId: id, response } });
    return this.db.getInteraction(id) as InteractionRequest;
  }

  async handleClaudeHook(sessionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = this.db.getSession(sessionId);
    if (!session || session.provider !== "claude") throw new Error("Claude session not found");
    const hook = String(body.hook_event_name ?? "");
    if (hook === "PermissionRequest") {
      const result = await this.requestInteraction(sessionId, {
        providerRequestId: `${String(body.session_id ?? sessionId)}:${Date.now()}`,
        kind: "permission_request", title: "Claude Code permission request",
        message: typeof body.tool_name === "string" ? `Tool: ${body.tool_name}` : undefined,
        riskLevel: body.tool_name === "Bash" ? "high" : "medium", request: body,
        availableDecisions: ["allow", "deny"],
      });
      return result;
    }
    if (hook === "PreToolUse" && body.tool_name === "AskUserQuestion") {
      const toolInput = body.tool_input && typeof body.tool_input === "object" ? body.tool_input as Record<string, unknown> : {};
      const result = await this.requestInteraction(sessionId, {
        providerRequestId: String(body.tool_use_id ?? `${String(body.session_id ?? sessionId)}:${Date.now()}`),
        kind: "question", title: "Claude Code needs your answer",
        message: "Answer these questions to continue the same Claude Code session.",
        riskLevel: "low", request: { ...body, questions: toolInput.questions ?? [] },
        availableDecisions: ["submit", "cancel"],
      });
      return result;
    }
    if (hook === "Elicitation") {
      const result = await this.requestInteraction(sessionId, {
        providerRequestId: String(body.elicitation_id ?? `${String(body.session_id ?? sessionId)}:${Date.now()}`),
        kind: "form", title: "Claude Code needs your input",
        message: typeof body.message === "string" ? body.message : undefined,
        riskLevel: "low", request: body, availableDecisions: ["accept", "decline", "cancel"],
      });
      return result;
    }
    if (hook === "Stop") {
      this.emit({ type: "turn.completed", taskId: session.taskId, sessionId, provider: "claude", payload: body });
    } else if (hook === "SessionEnd") {
      this.emit({ type: "session.ended", taskId: session.taskId, sessionId, provider: "claude", payload: body });
    } else {
      this.emit({ type: "provider.hook", taskId: session.taskId, sessionId, provider: "claude", payload: body });
    }
    return {};
  }

  approveReview(taskId: string): Task {
    if (!this.db.getTask(taskId)) throw new Error("Task not found");
    this.db.setTaskStatus(taskId, "done", now());
    this.emit({ type: "task.done", taskId, sessionId: null, provider: null, payload: {} });
    return this.db.getTask(taskId) as Task;
  }

  requestChanges(taskId: string): Task {
    if (!this.db.getTask(taskId)) throw new Error("Task not found");
    this.db.setTaskStatus(taskId, "in_progress", now());
    return this.db.getTask(taskId) as Task;
  }

  async cancelTask(taskId: string): Promise<Task> {
    if (!this.db.getTask(taskId)) throw new Error("Task not found");
    for (const session of this.db.listSessions(taskId)) {
      if (session.runtimeStatus === "starting" || session.runtimeStatus === "running" || session.runtimeStatus === "waiting") {
        try { await this.#adapters[session.provider].terminate(session.id); } catch { /* process may already have exited */ }
        this.#rejectSessionInteractions(session.id, new Error("Task was cancelled"));
        this.db.staleSessionInteractions(session.id, now());
        this.db.updateSession(session.id, { runtimeStatus: "stopped", endedAt: now() }, now());
      }
    }
    this.db.setTaskStatus(taskId, "cancelled", now());
    this.emit({ type: "task.cancelled", taskId, sessionId: null, provider: null, payload: {} });
    return this.db.getTask(taskId) as Task;
  }

  async health(): Promise<Record<string, unknown>> {
    const [native, docker, codex, claude] = await Promise.all([
      this.#native.checkHealth(), this.#docker.checkHealth(),
      this.#adapters.codex.checkInstallation(), this.#adapters.claude.checkInstallation(),
    ]);
    return { status: "ok", name: "Agents-Workspaces", version: "0.1.0", executors: { native, docker }, providers: { codex, claude } };
  }

  #providerResponse(interaction: InteractionRequest, response: Record<string, unknown>): Record<string, unknown> {
    if (interaction.provider === "claude") {
      if (interaction.kind === "permission_request") {
        const allow = response.decision === "allow";
        return {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: allow ? { behavior: "allow" } : { behavior: "deny", message: String(response.reason ?? "Denied in Agents-Workspaces") },
          },
        };
      }
      if (interaction.kind === "form") {
        return { hookSpecificOutput: { hookEventName: "Elicitation", action: response.action ?? "accept", content: response.content ?? {} } };
      }
      if (interaction.kind === "question") {
        if (response.decision === "cancel") {
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "User cancelled the question in Agents-Workspaces" } };
        }
        const toolInput = interaction.request.tool_input && typeof interaction.request.tool_input === "object"
          ? interaction.request.tool_input as Record<string, unknown> : {};
        const questions = Array.isArray(interaction.request.questions)
          ? interaction.request.questions as Array<Record<string, unknown>> : [];
        const submitted = response.answers && typeof response.answers === "object"
          ? response.answers as Record<string, unknown> : {};
        const answers: Record<string, string> = {};
        for (const question of questions) {
          const key = String(question.id ?? question.question ?? question.header ?? "question");
          const value = submitted[key];
          if (typeof value === "string") answers[String(question.question ?? key)] = value;
          else if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).answers)) {
            answers[String(question.question ?? key)] = ((value as { answers: unknown[] }).answers).map(String).join(", ");
          }
        }
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse", permissionDecision: "allow",
            updatedInput: { ...toolInput, answers },
          },
        };
      }
      return response;
    }
    if (interaction.kind === "command_approval" || interaction.kind === "file_approval") return { decision: response.decision ?? "decline" };
    if (interaction.kind === "permission_request") {
      return response.decision === "accept"
        ? { permissions: interaction.request.permissions ?? {}, scope: response.scope ?? "turn" }
        : { permissions: {}, scope: "turn" };
    }
    if (interaction.kind === "question") return { answers: response.answers ?? {} };
    if (interaction.kind === "form") return { action: response.action ?? "accept", content: response.content ?? {}, _meta: null };
    return response;
  }

  #applyEventState(event: AgentEvent): void {
    if (!event.sessionId) return;
    const session = this.db.getSession(event.sessionId);
    if (!session) return;
    if (event.type === "session.started" || event.type === "session.initialized") {
      const payload = event.payload as Record<string, unknown>;
      this.db.updateSession(session.id, {
        runtimeStatus: "running",
        ...(typeof payload.providerSessionId === "string" ? { providerSessionId: payload.providerSessionId } : {}),
      }, now());
    } else if (event.type === "turn.completed") {
      const payload = event.payload as Record<string, unknown>;
      this.db.updateSession(session.id, { runtimeStatus: "stopped", summary: typeof payload.result === "string" ? payload.result : session.summary }, now());
      this.db.staleSessionInteractions(session.id, now());
      this.#recomputeTaskStatus(session.taskId);
      this.#notify("Agents-Workspaces review ready", this.db.getTask(session.taskId)?.title ?? session.taskId);
    } else if (event.type === "session.failed") {
      this.db.updateSession(session.id, { runtimeStatus: "failed", error: JSON.stringify(event.payload), endedAt: now() }, now());
      this.#rejectSessionInteractions(session.id, new Error("Agent session failed"));
      this.db.staleSessionInteractions(session.id, now());
      this.#recomputeTaskStatus(session.taskId);
    } else if (event.type === "session.ended") {
      this.db.updateSession(session.id, { runtimeStatus: "stopped", endedAt: now() }, now());
      this.#rejectSessionInteractions(session.id, new Error("Agent session ended"));
      this.db.staleSessionInteractions(session.id, now());
      this.#recomputeTaskStatus(session.taskId);
    }
  }

  #recomputeTaskStatus(taskId: string): void {
    const task = this.db.getTask(taskId);
    if (!task) return;
    const status = deriveTaskStatus({
      hasStarted: task.startedAt !== null,
      reviewRequired: task.reviewRequired,
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      ...(task.cancelledAt ? { cancelledAt: task.cancelledAt } : {}),
      sessions: this.db.listSessions(taskId).map((session) => ({ runtimeStatus: session.runtimeStatus })),
      interactions: this.db.listInteractions(taskId).map((interaction) => ({ status: interaction.status })),
    });
    this.db.setTaskStatus(taskId, status, now());
  }

  #notify(title: string, message: string): void {
    if (process.platform !== "darwin") return;
    execFile("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], () => undefined);
  }

  #rejectSessionInteractions(sessionId: string, error: Error): void {
    for (const [id, pending] of this.#pendingInteractions) {
      if (pending.sessionId !== sessionId) continue;
      pending.reject(error);
      this.#pendingInteractions.delete(id);
    }
  }
}
