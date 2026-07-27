import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ClaudeAdapter, claudeCodeInteractionEvent, parseClaudeCodeHook } from "@agents-workspaces/agent-claude";
import type { AdapterInteractionInput, AgentAdapter } from "@agents-workspaces/agent-core";
import { CodexAdapter } from "@agents-workspaces/agent-codex";
import {
  createId,
  deriveTaskStatus,
  now,
  type AgentEvent,
  type AgentRun,
  type AgentProvider,
  type AgentSession,
  type ConversationMessage,
  type ExecutionProfile,
  type InteractionRequest,
  type Task,
  type Workspace,
  type Project,
  type WorkspaceProject,
  type SessionAttempt,
} from "@agents-workspaces/core";
import { AppDatabase, createDatabaseConfig } from "@agents-workspaces/database";
import { DockerExecutor } from "@agents-workspaces/executor-docker";
import { NativeExecutor } from "@agents-workspaces/executor-native";
import {
  addWorkspaceWorktree,
  cloneManagedRepository,
  gitDefaultBranch,
  gitRemoteUrl,
  inspectChanges,
  repositoryNameFromSource,
  safeDirectoryName,
  validateGitRepository,
} from "@agents-workspaces/workspace-manager";

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

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentBoardRuntime {
  readonly db: AppDatabase;
  readonly config: RuntimeConfig;
  readonly #events = new EventEmitter();
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  readonly #sessionMessageQueues = new Map<string, Promise<void>>();
  readonly #native = new NativeExecutor();
  readonly #docker = new DockerExecutor();
  readonly #adapters: Record<AgentProvider, AgentAdapter>;

  constructor(config = loadRuntimeConfig(), adapters: Partial<Record<AgentProvider, AgentAdapter>> = {}) {
    this.config = config;
    this.db = new AppDatabase(createDatabaseConfig(config.dataDirectory).filePath);
    const hooks = {
      emit: (event: Omit<AgentEvent, "id" | "occurredAt" | "schemaVersion">) => this.emit(event),
      requestInteraction: (sessionId: string, input: AdapterInteractionInput) => this.requestInteraction(sessionId, input),
    };
    this.#adapters = {
      codex: adapters.codex ?? new CodexAdapter(hooks),
      claude: adapters.claude ?? new ClaudeAdapter(hooks),
    };
    for (const session of this.db.recoverInterruptedSessions(now())) this.db.setTaskStatus(session.taskId, "needs_attention", now());
    this.#recoverFailedTurns();
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

  #emitAgUi(session: AgentSession, event: Record<string, unknown> & { type: string }): void {
    this.emit({
      type: event.type,
      taskId: session.taskId,
      sessionId: session.id,
      provider: session.provider,
      payload: event,
    });
  }

  #emitUserMessage(session: AgentSession, message: string, messageId = createId("message")): void {
    const timestamp = Date.now();
    this.#emitAgUi(session, { type: "TEXT_MESSAGE_START", messageId, role: "user", timestamp });
    this.#emitAgUi(session, { type: "TEXT_MESSAGE_CONTENT", messageId, delta: message, timestamp });
    this.#emitAgUi(session, { type: "TEXT_MESSAGE_END", messageId, timestamp });
  }

  async createWorkspace(input: { name: string; rootPath?: string; branchName?: string }): Promise<Workspace> {
    const at = now();
    const id = createId("workspace");
    const rootPath = input.rootPath
      ? expandHome(input.rootPath)
      : join(this.config.workspaceRoot, safeDirectoryName(input.name));
    await mkdir(resolve(rootPath, ".."), { recursive: true });
    try {
      await mkdir(rootPath, { recursive: false });
    } catch (error) {
      throw badRequest(`Workspace directory cannot be created: ${messageOf(error)}`);
    }
    const workspace = this.db.insertWorkspace({
      id, name: input.name, rootPath,
      branchPrefix: input.branchName ?? `workspace/${id}`,
      status: "ready", createdAt: at, updatedAt: at,
    });
    this.emit({ type: "workspace.created", taskId: null, sessionId: null, provider: null, payload: workspace });
    return workspace;
  }

  workspaceDetails(workspaceId: string, includeTaskEvents = true): Record<string, unknown> {
    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace) throw badRequest("Workspace not found");
    const links = this.db.listWorkspaceProjects(workspace.id);
    const projects = this.db.getProjects(links.map((item) => item.projectId));
    const byId = new Map(projects.map((item) => [item.id, item]));
    const tasks = this.db.listTasks(workspace.id).map((task) =>
      includeTaskEvents ? this.taskDetails(task.id) : this.taskSummary(task.id),
    );
    return {
      workspace,
      projects: links.map((link) => ({ ...byId.get(link.projectId), ...link })),
      tasks,
    };
  }

  listWorkspaceDetails(): Record<string, unknown>[] {
    return this.db.listWorkspaces().map((workspace) => this.workspaceDetails(workspace.id, false));
  }

  async addProjectToWorkspace(workspaceId: string, input: { sourceType: "remote"; remoteUrl: string } | { sourceType: "local"; localPath: string }): Promise<{ project: Project; link: WorkspaceProject }> {
    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace || workspace.status !== "ready") throw badRequest("Workspace not found or not ready");
    let remoteUrl: string;
    if (input.sourceType === "local") {
      try { remoteUrl = await gitRemoteUrl(await validateGitRepository(resolve(input.localPath))); }
      catch (error) { throw badRequest(`Local repository is invalid: ${messageOf(error)}`); }
    } else remoteUrl = input.remoteUrl;

    const registered = this.db.listProjects();
    let project = registered.find((item) => item.remoteUrl === remoteUrl) ?? null;
    if (!project) {
      const name = repositoryNameFromSource(remoteUrl);
      if (registered.some((item) => item.name === name)) throw badRequest(`A different Project already uses the name "${name}"`);
      let localPath: string;
      let baseBranch: string;
      try {
        localPath = await cloneManagedRepository(remoteUrl, join(this.config.dataDirectory, "repositories", name));
        baseBranch = await gitDefaultBranch(localPath);
      } catch (error) {
        throw badRequest(`Unable to clone Project: ${messageOf(error)}`);
      }
      const at = now();
      project = this.db.insertProject({ id: createId("project"), name, localPath, remoteUrl, baseBranch, createdAt: at, updatedAt: at });
      this.emit({ type: "project.registered", taskId: null, sessionId: null, provider: null, payload: project });
    }

    if (this.db.listWorkspaceProjects(workspace.id).some((item) => item.projectId === project.id)) {
      throw badRequest(`${project.name} is already in this Workspace`);
    }
    let worktree: Awaited<ReturnType<typeof addWorkspaceWorktree>>;
    try {
      worktree = await addWorkspaceWorktree(workspace.rootPath, {
        repositoryId: project.id, repositoryName: project.name, repositoryPath: project.localPath,
        directoryName: project.name, baseBranch: project.baseBranch, taskBranch: workspace.branchPrefix,
      }, true);
    } catch (error) {
      throw badRequest(`Unable to create Project worktree: ${messageOf(error)}`);
    }
    const link = this.db.insertWorkspaceProject({
      id: createId("workspaceProject"), workspaceId: workspace.id, projectId: project.id,
      branch: worktree.taskBranch, worktreePath: worktree.worktreePath,
      baseBranch: worktree.baseBranch, createdAt: now(),
    });
    this.emit({ type: "workspace.project-added", taskId: null, sessionId: null, provider: null, payload: { workspaceId, project, link } });
    return { project, link };
  }

  async createAgentTask(workspaceId: string, input: { title: string; provider: AgentProvider; executorType: "native" | "docker"; prompt: string; executionProfileId?: string; startImmediately?: boolean }): Promise<Record<string, unknown>> {
    const workspace = this.db.getWorkspace(workspaceId);
    if (!workspace) throw badRequest("Workspace not found");
    if (!this.db.listWorkspaceProjects(workspace.id).length) throw badRequest("Add at least one Project before creating a Task");
    const at = now();
    const task = this.db.insertTask({
      id: createId("task"), workspaceId: workspace.id, title: input.title, description: input.prompt,
      status: "todo", reviewRequired: false, createdAt: at, updatedAt: at, startedAt: null, completedAt: null, cancelledAt: null,
    });
    this.emit({ type: "task.created", taskId: task.id, sessionId: null, provider: null, payload: task });
    if (input.startImmediately !== false) {
      await this.startSession(task.id, {
        provider: input.provider, executorType: input.executorType, prompt: input.prompt,
        ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      });
    }
    return { ...this.taskDetails(task.id), workspace };
  }

  taskDetails(taskId: string): Record<string, unknown> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const workspace = this.db.getWorkspace(task.workspaceId);
    return {
      task,
      workspace,
      projects: workspace ? this.db.listWorkspaceProjects(workspace.id) : [],
      sessions: this.db.listSessions(taskId),
      runs: this.db.listAgentRuns(taskId),
      attempts: this.db.listSessions(taskId).flatMap((session) => this.db.listAttempts(session.id)),
      messages: this.db.listMessages(taskId),
      interactions: this.db.listInteractions(taskId),
      events: this.db.listEvents(taskId),
    };
  }

  taskSummary(taskId: string): Record<string, unknown> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    return {
      task,
      sessions: this.db.listSessions(taskId),
      runs: this.db.listAgentRuns(taskId),
      messages: this.db.listMessages(taskId),
      interactions: this.db.listInteractions(taskId),
      events: [],
    };
  }

  async taskChanges(taskId: string): Promise<unknown[]> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const projects = this.db.listWorkspaceProjects(task.workspaceId);
    const projectRows = this.db.getProjects(projects.map((item) => item.projectId));
    const byId = new Map(projectRows.map((project) => [project.id, project]));
    return inspectChanges(projects.map((item) => ({
      repositoryId: item.projectId,
      repositoryName: byId.get(item.projectId)?.name ?? item.projectId,
      worktreePath: item.worktreePath,
      baseBranch: item.baseBranch,
    })));
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
    if (!task) throw new Error("Task not found");
    const workspace = this.db.getWorkspace(task.workspaceId);
    if (!workspace || workspace.status !== "ready") throw new Error("A ready Workspace is required");
    const profile = input.executionProfileId ? this.db.getExecutionProfile(input.executionProfileId) : null;
    if (profile && (profile.provider !== input.provider || profile.type !== input.executorType)) throw new Error("Execution Profile does not match provider/executor");
    const at = now();
    const session: AgentSession = {
      id: createId("session"), taskId, provider: input.provider,
      executorType: input.executorType, executionProfileId: profile?.id ?? null,
      providerSessionId: null, providerTurnId: null, runtimeStatus: "starting", prompt: input.prompt,
      summary: null, error: null, createdAt: at, updatedAt: at, endedAt: null,
    };
    this.db.insertSession(session);
    this.db.markTaskStarted(taskId, at);
    const initialMessage = this.db.insertMessage({
      id: createId("message"), clientMessageId: createId("clientMessage"), taskId, sessionId: session.id,
      role: "user", content: input.prompt, status: "queued", error: null,
      createdAt: at, updatedAt: at, acceptedAt: null,
    });
    this.db.updateMessage(initialMessage.id, { status: "submitting", error: null }, now());
    try {
      await this.#startAdapter(session, input.prompt, profile, profile?.image ?? input.image);
      const acceptedAt = now();
      this.db.updateMessage(initialMessage.id, { status: "accepted", error: null, acceptedAt }, acceptedAt);
      this.#emitUserMessage(session, input.prompt, initialMessage.id);
      return this.db.getSession(session.id) as AgentSession;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateMessage(initialMessage.id, { status: "failed", error: message }, now());
      this.db.updateSession(session.id, { runtimeStatus: "failed", error: message, endedAt: now() }, now());
      this.db.setTaskStatus(taskId, "needs_attention", now());
      throw error;
    }
  }

  async sendMessage(sessionId: string, content: string, clientMessageId = createId("clientMessage")): Promise<ConversationMessage> {
    return this.#withSessionMessageLock(sessionId, async () => {
      const session = this.db.getSession(sessionId);
      if (!session) throw new Error("Session not found");
      const at = now();
      const persisted = this.db.insertMessage({
        id: createId("message"), clientMessageId, taskId: session.taskId, sessionId,
        role: "user", content, status: "queued", error: null, createdAt: at, updatedAt: at, acceptedAt: null,
      });
      if (persisted.status === "accepted") return persisted;
      this.db.updateMessage(persisted.id, { status: "submitting", error: null }, now());
      const adapter = this.#adapters[session.provider];
      try {
        if (adapter.isRunning(sessionId)) {
          const attempt = this.db.latestAttempt(sessionId);
          if (attempt) this.db.updateAttempt(attempt.id, { status: "running", error: null, endedAt: null }, now());
          await adapter.sendMessage(sessionId, content);
        } else {
          const profile = session.executionProfileId ? this.db.getExecutionProfile(session.executionProfileId) : null;
          await this.#startAdapter(session, content, profile, profile?.image ?? undefined);
        }
        const acceptedAt = now();
        this.db.updateMessage(persisted.id, { status: "accepted", error: null, acceptedAt }, acceptedAt);
        this.#emitUserMessage(session, content, persisted.id);
        this.db.updateSession(sessionId, { runtimeStatus: "running", error: null, endedAt: null }, acceptedAt);
        this.db.setTaskStatus(session.taskId, "in_progress", acceptedAt);
        return this.db.getMessage(persisted.id) as ConversationMessage;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.db.updateMessage(persisted.id, { status: "failed", error: detail }, now());
        this.emit({
          type: "session.error", taskId: session.taskId, sessionId, provider: session.provider,
          payload: { message: `Unable to send message: ${detail}`, willRetry: false },
        });
        throw new Error(`Unable to send message: ${detail}`);
      }
    });
  }

  /**
   * The AG-UI boundary uses a Task as the durable Thread. This method is the
   * only place where a protocol Run is mapped to the current provider Session.
   */
  async runTaskMessage(taskId: string, runId: string, content: string): Promise<AgentRun> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const session = this.db.listSessions(taskId).at(-1);
    if (!session) throw badRequest("Task has no Agent session");
    const existing = this.db.getAgentRun(runId);
    if (existing) return existing;
    const startedAt = now();
    const run: AgentRun = {
      id: runId, taskId, sessionId: session.id, status: "running", startedAt, endedAt: null, error: null,
    };
    this.db.insertAgentRun(run);
    this.emit({
      type: "RUN_STARTED", taskId, sessionId: session.id, provider: session.provider,
      payload: { type: "RUN_STARTED", threadId: taskId, runId, timestamp: Date.now() },
    });
    try {
      await this.sendMessage(session.id, content, `run:${runId}`);
      return run;
    } catch (error) {
      const message = messageOf(error);
      this.db.updateAgentRun(run.id, { status: "failed", endedAt: now(), error: message });
      this.emit({
        type: "RUN_ERROR", taskId, sessionId: session.id, provider: session.provider,
        payload: { type: "RUN_ERROR", threadId: taskId, runId, message, timestamp: Date.now() },
      });
      throw error;
    }
  }

  completeAgentRun(runId: string, status: AgentRun["status"], error: string | null = null): AgentRun | null {
    const run = this.db.getAgentRun(runId);
    if (!run || run.status !== "running") return run;
    this.db.updateAgentRun(runId, { status, endedAt: now(), error });
    return this.db.getAgentRun(runId);
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
    const attempt = this.db.latestAttempt(sessionId);
    if (attempt) this.db.updateAttempt(attempt.id, { status: "stopped", endedAt: now() }, now());
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
    const attempt = this.db.latestAttempt(sessionId);
    if (attempt) this.db.updateAttempt(attempt.id, { status: "waiting" }, now());
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
    const attempt = this.db.latestAttempt(interaction.sessionId);
    if (attempt) this.db.updateAttempt(attempt.id, { status: "running" }, now());
    this.#recomputeTaskStatus(interaction.taskId);
    this.emit({ type: "interaction.resolved", taskId: interaction.taskId, sessionId: interaction.sessionId, provider: interaction.provider, payload: { interactionId: id, response } });
    return this.db.getInteraction(id) as InteractionRequest;
  }

  async handleClaudeHook(sessionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = this.db.getSession(sessionId);
    if (!session || session.provider !== "claude") throw new Error("Claude session not found");
    const hook = String(body.hook_event_name ?? "");
    const parsedInteraction = parseClaudeCodeHook(body);
    if (parsedInteraction) {
      const interactionEvent = claudeCodeInteractionEvent(parsedInteraction);
      this.#emitAgUi(session, interactionEvent as unknown as Record<string, unknown> & { type: string });
      const toolInput = body.tool_input && typeof body.tool_input === "object" ? body.tool_input as Record<string, unknown> : {};
      return this.requestInteraction(sessionId, {
        providerRequestId: parsedInteraction.requestId,
        kind: parsedInteraction.kind,
        title: parsedInteraction.title,
        ...(parsedInteraction.kind === "permission_request" && typeof body.tool_name === "string"
          ? { message: `Tool: ${body.tool_name}` }
          : parsedInteraction.kind === "question"
            ? { message: "Answer these questions to continue the same Claude Code session." }
            : typeof body.message === "string" ? { message: body.message } : {}),
        riskLevel: parsedInteraction.riskLevel,
        request: parsedInteraction.kind === "question" ? { ...body, questions: toolInput.questions ?? [] } : body,
        availableDecisions: parsedInteraction.availableDecisions,
      });
    }
    if (hook === "SessionEnd") {
      this.emit({ type: "session.ended", taskId: session.taskId, sessionId, provider: "claude", payload: body });
    } else {
      this.#emitAgUi(session, { type: "CUSTOM", name: "claude-code.hook", value: body, timestamp: Date.now() });
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

  async archiveTask(taskId: string): Promise<Task> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    await this.#stopTaskSessions(taskId, "Task was archived");
    this.db.setTaskStatus(taskId, "archived", now());
    this.emit({ type: "task.archived", taskId, sessionId: null, provider: null, payload: {} });
    return this.db.getTask(taskId) as Task;
  }

  async deleteTask(taskId: string): Promise<{ deleted: true }> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    await this.#stopTaskSessions(taskId, "Task was deleted");
    this.db.deleteTask(taskId);
    return { deleted: true };
  }

  async cancelTask(taskId: string): Promise<Task> {
    if (!this.db.getTask(taskId)) throw new Error("Task not found");
    for (const session of this.db.listSessions(taskId)) {
      if (session.runtimeStatus === "starting" || session.runtimeStatus === "running" || session.runtimeStatus === "waiting") {
        try { await this.#adapters[session.provider].terminate(session.id); } catch { /* process may already have exited */ }
        this.#rejectSessionInteractions(session.id, new Error("Task was cancelled"));
        this.db.staleSessionInteractions(session.id, now());
        this.db.updateSession(session.id, { runtimeStatus: "stopped", endedAt: now() }, now());
        const attempt = this.db.latestAttempt(session.id);
        if (attempt) this.db.updateAttempt(attempt.id, { status: "stopped", endedAt: now() }, now());
      }
    }
    this.db.setTaskStatus(taskId, "cancelled", now());
    this.emit({ type: "task.cancelled", taskId, sessionId: null, provider: null, payload: {} });
    return this.db.getTask(taskId) as Task;
  }

  async #stopTaskSessions(taskId: string, reason: string): Promise<void> {
    for (const session of this.db.listSessions(taskId)) {
      if (this.#adapters[session.provider].isRunning(session.id)) {
        try { await this.#adapters[session.provider].terminate(session.id); } catch { /* process may already have exited */ }
      }
      this.#rejectSessionInteractions(session.id, new Error(reason));
      this.db.staleSessionInteractions(session.id, now());
      if (session.runtimeStatus === "starting" || session.runtimeStatus === "running" || session.runtimeStatus === "waiting" || session.runtimeStatus === "suspended") {
        this.db.updateSession(session.id, { runtimeStatus: "stopped", endedAt: now() }, now());
      }
      const attempt = this.db.latestAttempt(session.id);
      if (attempt && !["completed", "failed", "interrupted", "stopped"].includes(attempt.status)) {
        this.db.updateAttempt(attempt.id, { status: "stopped", endedAt: now() }, now());
      }
    }
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
    if (event.type === "session.started" || event.type === "RUN_STARTED") {
      const payload = event.payload as Record<string, unknown>;
      this.db.updateSession(session.id, {
        runtimeStatus: "running",
        ...(typeof payload.providerSessionId === "string" ? { providerSessionId: payload.providerSessionId } : {}),
      }, now());
      const attempt = this.db.latestAttempt(session.id);
      if (attempt) this.db.updateAttempt(attempt.id, {
        status: "running",
        ...(typeof payload.providerSessionId === "string" ? { providerSessionId: payload.providerSessionId } : {}),
      }, now());
    } else if (event.type === "session.error" || event.type === "RUN_ERROR") {
      const payload = event.payload as Record<string, unknown>;
      if (payload.willRetry !== true) {
        this.db.updateSession(session.id, { runtimeStatus: "failed", error: JSON.stringify(payload.error ?? payload) }, now());
        const attempt = this.db.latestAttempt(session.id);
        if (attempt) this.db.updateAttempt(attempt.id, { status: "failed", error: JSON.stringify(payload.error ?? payload), endedAt: now() }, now());
        this.db.setTaskStatus(session.taskId, "needs_attention", now());
        this.#notify("Agents-Workspaces Task failed", this.db.getTask(session.taskId)?.title ?? session.taskId);
      }
    } else if (event.type === "RUN_FINISHED") {
      const payload = event.payload as Record<string, unknown>;
      const failed = payload.is_error === true;
      this.db.updateSession(session.id, failed
        ? { runtimeStatus: "failed", error: JSON.stringify(payload.error ?? payload) }
        : { runtimeStatus: "stopped", summary: typeof payload.result === "string" ? payload.result : session.summary }, now());
      const attempt = this.db.latestAttempt(session.id);
      if (attempt) this.db.updateAttempt(attempt.id, failed
        ? { status: "failed", error: JSON.stringify(payload.error ?? payload), endedAt: now() }
        : { status: "idle", error: null }, now());
      this.db.staleSessionInteractions(session.id, now());
      this.#recomputeTaskStatus(session.taskId);
      this.#notify(failed ? "Agents-Workspaces Task failed" : "Agents-Workspaces review ready", this.db.getTask(session.taskId)?.title ?? session.taskId);
    } else if (event.type === "session.failed") {
      this.db.updateSession(session.id, { runtimeStatus: "failed", error: JSON.stringify(event.payload), endedAt: now() }, now());
      const attempt = this.db.latestAttempt(session.id);
      if (attempt) this.db.updateAttempt(attempt.id, { status: "failed", error: JSON.stringify(event.payload), endedAt: now() }, now());
      this.#rejectSessionInteractions(session.id, new Error("Agent session failed"));
      this.db.staleSessionInteractions(session.id, now());
      this.#recomputeTaskStatus(session.taskId);
    } else if (event.type === "session.ended") {
      this.db.updateSession(session.id, { runtimeStatus: "stopped", endedAt: now() }, now());
      const attempt = this.db.latestAttempt(session.id);
      if (attempt) this.db.updateAttempt(attempt.id, { status: "completed", endedAt: now() }, now());
      this.#rejectSessionInteractions(session.id, new Error("Agent session ended"));
      this.db.staleSessionInteractions(session.id, now());
      this.#recomputeTaskStatus(session.taskId);
    }
  }

  #recomputeTaskStatus(taskId: string): void {
    const task = this.db.getTask(taskId);
    if (!task) return;
    if (task.status === "archived") return;
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

  #recoverFailedTurns(): void {
    const failed = new Map<string, { sessionId: string; error: string }>();
    for (const event of this.db.listEvents(undefined, 0, 100_000)) {
      if (!event.taskId || !event.sessionId) continue;
      const payload = event.payload as Record<string, unknown>;
      if ((event.type === "RUN_ERROR") || (event.type === "session.error" && payload.willRetry !== true)) {
        failed.set(event.taskId, { sessionId: event.sessionId, error: JSON.stringify(payload.error ?? payload) });
      } else if (event.type === "RUN_FINISHED" || event.type === "session.started" || event.type === "RUN_STARTED") {
        failed.delete(event.taskId);
      }
    }
    for (const [taskId, value] of failed) {
      this.db.updateSession(value.sessionId, { runtimeStatus: "failed", error: value.error }, now());
      this.db.setTaskStatus(taskId, "needs_attention", now());
    }
  }

  #rejectSessionInteractions(sessionId: string, error: Error): void {
    for (const [id, pending] of this.#pendingInteractions) {
      if (pending.sessionId !== sessionId) continue;
      pending.reject(error);
      this.#pendingInteractions.delete(id);
    }
  }

  async #startAdapter(session: AgentSession, prompt: string, profile: ExecutionProfile | null, image?: string): Promise<void> {
    const task = this.db.getTask(session.taskId);
    const workspace = task ? this.db.getWorkspace(task.workspaceId) : null;
    if (!workspace || workspace.status !== "ready") throw new Error("A ready Workspace is required to resume this session");
    const at = now();
    const attempt: SessionAttempt = {
      id: createId("attempt"), sessionId: session.id, status: "starting",
      resumed: Boolean(session.providerSessionId), providerSessionId: session.providerSessionId,
      error: null, startedAt: at, updatedAt: at, endedAt: null,
    };
    this.db.insertAttempt(attempt);
    this.db.updateSession(session.id, { runtimeStatus: "starting", error: null, endedAt: null }, at);
    const executor = session.executorType === "native" ? this.#native : this.#docker;
    try {
      const handle = await this.#adapters[session.provider].start({
        sessionId: session.id, taskId: session.taskId, workspacePath: workspace.rootPath, prompt, executor,
        gatewayUrl: session.executorType === "docker"
          ? `http://host.docker.internal:${this.config.port}`
          : `http://${this.config.host}:${this.config.port}`,
        hookToken: this.config.hookToken,
        ...(image ? { image } : {}),
        ...(profile ? { environment: profile.environment } : {}),
        ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
      });
      this.db.updateAttempt(attempt.id, { status: "running", providerSessionId: handle.providerSessionId, error: null }, now());
      this.db.updateSession(session.id, { runtimeStatus: "running", providerSessionId: handle.providerSessionId, error: null, endedAt: null }, now());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.db.updateAttempt(attempt.id, { status: "failed", error: detail, endedAt: now() }, now());
      throw error;
    }
  }

  async #withSessionMessageLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#sessionMessageQueues.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.#sessionMessageQueues.set(sessionId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#sessionMessageQueues.get(sessionId) === tail) this.#sessionMessageQueues.delete(sessionId);
    }
  }
}
