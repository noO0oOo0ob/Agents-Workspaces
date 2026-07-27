import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AgentEvent,
  AgentRun,
  AgentSession,
  ConversationMessage,
  ExecutionProfile,
  InteractionRequest,
  Project,
  SessionAttempt,
  Task,
  TaskStatus,
  Workspace,
  WorkspaceProject,
} from "@agents-workspaces/core";

export interface DatabaseConfig {
  filePath: string;
  journalMode: "wal";
}

export function createDatabaseConfig(dataDirectory: string): DatabaseConfig {
  return { filePath: resolve(dataDirectory, "agents-workspaces.sqlite"), journalMode: "wal" };
}

type Row = Record<string, SQLInputValue>;

function text(value: SQLInputValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: SQLInputValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function json<T>(value: SQLInputValue | undefined, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

/**
 * Database schema for the clean Workspace-first model. Existing data is not
 * migrated; a new database starts with this schema only.
 */
export class AppDatabase {
  readonly #db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.#db = new DatabaseSync(filePath);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void { this.#db.close(); }

  migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        branch_prefix TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT NOT NULL UNIQUE,
        remote_url TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_projects (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id), branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, project_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
        review_required INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT,
        completed_at TEXT, cancelled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, provider TEXT NOT NULL,
        image TEXT, environment_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, executor_type TEXT NOT NULL, execution_profile_id TEXT,
        provider_session_id TEXT, provider_turn_id TEXT, runtime_status TEXT NOT NULL,
        prompt TEXT NOT NULL, summary TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS session_attempts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL, resumed INTEGER NOT NULL DEFAULT 0, provider_session_id TEXT,
        error TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY, client_message_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, accepted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_request_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL, message TEXT, risk_level TEXT NOT NULL,
        request_json TEXT NOT NULL, available_decisions_json TEXT NOT NULL, status TEXT NOT NULL,
        response_json TEXT, created_at TEXT NOT NULL, responded_at TEXT, resolved_at TEXT,
        UNIQUE(provider, provider_request_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
        task_id TEXT, session_id TEXT, provider TEXT, occurred_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_projects_workspace ON workspace_projects(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_task ON agent_sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_session ON session_attempts(session_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_messages_task ON conversation_messages(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_interactions_task_status ON interactions(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_task_sequence ON events(task_id, sequence);
    `);
  }

  insertWorkspace(value: Workspace): Workspace {
    this.#db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.name, value.rootPath, value.branchPrefix, value.status, value.createdAt, value.updatedAt);
    return value;
  }

  listWorkspaces(): Workspace[] {
    return this.#db.prepare("SELECT * FROM workspaces WHERE status != 'archived' ORDER BY updated_at DESC").all().map(this.#workspace);
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.#db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? this.#workspace(row) : null;
  }

  insertProject(value: Project): Project {
    this.#db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.name, value.localPath, value.remoteUrl, value.baseBranch, value.createdAt, value.updatedAt);
    return value;
  }

  listProjects(): Project[] {
    return this.#db.prepare("SELECT * FROM projects ORDER BY name").all().map(this.#project);
  }

  getProjects(ids: string[]): Project[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.#db.prepare(`SELECT * FROM projects WHERE id IN (${placeholders})`).all(...ids).map(this.#project);
  }

  insertWorkspaceProject(value: WorkspaceProject): WorkspaceProject {
    this.#db.prepare("INSERT INTO workspace_projects VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.workspaceId, value.projectId, value.branch, value.worktreePath, value.baseBranch, value.createdAt);
    return value;
  }

  listWorkspaceProjects(workspaceId: string): WorkspaceProject[] {
    return this.#db.prepare("SELECT * FROM workspace_projects WHERE workspace_id = ? ORDER BY worktree_path").all(workspaceId).map(this.#workspaceProject);
  }

  insertTask(value: Task): Task {
    this.#db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.workspaceId, value.title, value.description, value.status, Number(value.reviewRequired), value.createdAt, value.updatedAt, value.startedAt, value.completedAt, value.cancelledAt);
    return value;
  }

  listTasks(workspaceId?: string): Task[] {
    const rows = workspaceId
      ? this.#db.prepare("SELECT * FROM tasks WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC").all(workspaceId)
      : this.#db.prepare("SELECT * FROM tasks WHERE status != 'archived' ORDER BY updated_at DESC").all();
    return rows.map(this.#task);
  }

  getTask(id: string): Task | null {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? this.#task(row) : null;
  }

  setTaskStatus(id: string, status: TaskStatus, at: string): void {
    const fields = status === "done" ? ", completed_at = ?" : status === "cancelled" ? ", cancelled_at = ?" : "";
    const values: SQLInputValue[] = [status, at];
    if (fields) values.push(at);
    values.push(id);
    this.#db.prepare(`UPDATE tasks SET status = ?, updated_at = ?${fields} WHERE id = ?`).run(...values);
  }

  deleteTask(id: string): void {
    this.#db.prepare("DELETE FROM events WHERE task_id = ?").run(id);
    this.#db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  markTaskStarted(id: string, at: string): void {
    this.#db.prepare("UPDATE tasks SET status = 'in_progress', review_required = 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?").run(at, at, id);
  }

  insertExecutionProfile(value: ExecutionProfile): ExecutionProfile {
    this.#db.prepare("INSERT INTO execution_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.name, value.type, value.provider, value.image, JSON.stringify(value.environment), value.createdAt, value.updatedAt);
    return value;
  }

  listExecutionProfiles(): ExecutionProfile[] {
    return this.#db.prepare("SELECT * FROM execution_profiles ORDER BY name").all().map(this.#executionProfile);
  }

  getExecutionProfile(id: string): ExecutionProfile | null {
    const row = this.#db.prepare("SELECT * FROM execution_profiles WHERE id = ?").get(id);
    return row ? this.#executionProfile(row) : null;
  }

  insertSession(value: AgentSession): AgentSession {
    this.#db.prepare("INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.taskId, value.provider, value.executorType, value.executionProfileId, value.providerSessionId, value.providerTurnId, value.runtimeStatus, value.prompt, value.summary, value.error, value.createdAt, value.updatedAt, value.endedAt);
    return value;
  }

  updateSession(id: string, patch: Partial<Pick<AgentSession, "providerSessionId" | "providerTurnId" | "runtimeStatus" | "summary" | "error" | "endedAt">>, at: string): void {
    const current = this.getSession(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: at };
    this.#db.prepare("UPDATE agent_sessions SET provider_session_id = ?, provider_turn_id = ?, runtime_status = ?, summary = ?, error = ?, updated_at = ?, ended_at = ? WHERE id = ?")
      .run(next.providerSessionId, next.providerTurnId, next.runtimeStatus, next.summary, next.error, next.updatedAt, next.endedAt, id);
  }

  getSession(id: string): AgentSession | null {
    const row = this.#db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id);
    return row ? this.#session(row) : null;
  }

  listSessions(taskId: string): AgentSession[] {
    return this.#db.prepare("SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY created_at").all(taskId).map(this.#session);
  }

  insertAttempt(value: SessionAttempt): SessionAttempt {
    this.#db.prepare("INSERT INTO session_attempts (id, session_id, status, resumed, provider_session_id, error, started_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.sessionId, value.status, Number(value.resumed), value.providerSessionId, value.error, value.startedAt, value.updatedAt, value.endedAt);
    return value;
  }

  updateAttempt(id: string, patch: Partial<Pick<SessionAttempt, "status" | "providerSessionId" | "error" | "endedAt">>, at: string): void {
    const current = this.getAttempt(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: at };
    this.#db.prepare("UPDATE session_attempts SET status = ?, provider_session_id = ?, error = ?, updated_at = ?, ended_at = ? WHERE id = ?")
      .run(next.status, next.providerSessionId, next.error, next.updatedAt, next.endedAt, id);
  }

  getAttempt(id: string): SessionAttempt | null {
    const row = this.#db.prepare("SELECT * FROM session_attempts WHERE id = ?").get(id);
    return row ? this.#attempt(row) : null;
  }

  listAttempts(sessionId: string): SessionAttempt[] {
    return this.#db.prepare("SELECT * FROM session_attempts WHERE session_id = ? ORDER BY started_at").all(sessionId).map(this.#attempt);
  }

  latestAttempt(sessionId: string): SessionAttempt | null {
    const row = this.#db.prepare("SELECT * FROM session_attempts WHERE session_id = ? ORDER BY started_at DESC LIMIT 1").get(sessionId);
    return row ? this.#attempt(row) : null;
  }

  insertAgentRun(value: AgentRun): AgentRun {
    this.#db.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.taskId, value.sessionId, value.status, value.startedAt, value.endedAt, value.error);
    return value;
  }

  getAgentRun(id: string): AgentRun | null {
    const row = this.#db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id);
    return row ? this.#agentRun(row) : null;
  }

  listAgentRuns(taskId: string): AgentRun[] {
    return this.#db.prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at").all(taskId).map(this.#agentRun);
  }

  updateAgentRun(id: string, patch: Partial<Pick<AgentRun, "status" | "endedAt" | "error">>): void {
    const current = this.getAgentRun(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.#db.prepare("UPDATE agent_runs SET status = ?, ended_at = ?, error = ? WHERE id = ?")
      .run(next.status, next.endedAt, next.error, id);
  }

  insertMessage(value: ConversationMessage): ConversationMessage {
    const existing = this.getMessageByClientId(value.clientMessageId);
    if (existing) {
      if (existing.sessionId !== value.sessionId || existing.content !== value.content) throw new Error("clientMessageId is already used by another message");
      return existing;
    }
    this.#db.prepare("INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.clientMessageId, value.taskId, value.sessionId, value.role, value.content, value.status, value.error, value.createdAt, value.updatedAt, value.acceptedAt);
    return value;
  }

  updateMessage(id: string, patch: Partial<Pick<ConversationMessage, "status" | "error" | "acceptedAt">>, at: string): void {
    const current = this.getMessage(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: at };
    this.#db.prepare("UPDATE conversation_messages SET status = ?, error = ?, updated_at = ?, accepted_at = ? WHERE id = ?")
      .run(next.status, next.error, next.updatedAt, next.acceptedAt, id);
  }

  getMessage(id: string): ConversationMessage | null {
    const row = this.#db.prepare("SELECT * FROM conversation_messages WHERE id = ?").get(id);
    return row ? this.#message(row) : null;
  }

  getMessageByClientId(clientMessageId: string): ConversationMessage | null {
    const row = this.#db.prepare("SELECT * FROM conversation_messages WHERE client_message_id = ?").get(clientMessageId);
    return row ? this.#message(row) : null;
  }

  listMessages(taskId: string): ConversationMessage[] {
    return this.#db.prepare("SELECT * FROM conversation_messages WHERE task_id = ? ORDER BY created_at").all(taskId).map(this.#message);
  }

  recoverInterruptedSessions(at: string): AgentSession[] {
    const rows = this.#db.prepare("SELECT * FROM agent_sessions WHERE runtime_status IN ('starting', 'running', 'waiting')").all();
    const sessions = rows.map(this.#session);
    this.#db.prepare("UPDATE session_attempts SET status = 'interrupted', error = 'Gateway restarted while the CLI process was active', updated_at = ?, ended_at = ? WHERE status IN ('starting', 'running', 'waiting', 'idle')").run(at, at);
    this.#db.prepare("UPDATE agent_sessions SET runtime_status = 'suspended', error = 'Gateway restarted; the Provider conversation can be resumed', updated_at = ?, ended_at = NULL WHERE runtime_status IN ('starting', 'running', 'waiting')").run(at);
    this.#db.prepare("UPDATE conversation_messages SET status = 'failed', error = 'Gateway restarted before the Provider accepted this message', updated_at = ? WHERE status IN ('queued', 'submitting')").run(at);
    this.#db.prepare("UPDATE interactions SET status = 'stale', resolved_at = ? WHERE status = 'pending'").run(at);
    return sessions;
  }

  insertInteraction(value: InteractionRequest): InteractionRequest {
    this.#db.prepare("INSERT OR IGNORE INTO interactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.provider, value.providerRequestId, value.taskId, value.sessionId, value.kind, value.title, value.message, value.riskLevel, JSON.stringify(value.request), JSON.stringify(value.availableDecisions), value.status, value.response ? JSON.stringify(value.response) : null, value.createdAt, value.respondedAt, value.resolvedAt);
    return this.getInteraction(value.id) ?? value;
  }

  getInteraction(id: string): InteractionRequest | null {
    const row = this.#db.prepare("SELECT * FROM interactions WHERE id = ?").get(id);
    return row ? this.#interaction(row) : null;
  }

  listInteractions(taskId?: string, status?: string): InteractionRequest[] {
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (taskId) { clauses.push("task_id = ?"); values.push(taskId); }
    if (status) { clauses.push("status = ?"); values.push(status); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.#db.prepare(`SELECT * FROM interactions${where} ORDER BY created_at DESC`).all(...values).map(this.#interaction);
  }

  respondInteraction(id: string, response: Record<string, unknown>, at: string): void {
    this.#db.prepare("UPDATE interactions SET status = 'responded', response_json = ?, responded_at = ? WHERE id = ? AND status = 'pending'")
      .run(JSON.stringify(response), at, id);
  }

  resolveInteraction(id: string, at: string): void {
    this.#db.prepare("UPDATE interactions SET status = 'resolved', resolved_at = ? WHERE id = ?").run(at, id);
  }

  staleSessionInteractions(sessionId: string, at: string): void {
    this.#db.prepare("UPDATE interactions SET status = 'stale', resolved_at = ? WHERE session_id = ? AND status = 'pending'").run(at, sessionId);
  }

  insertEvent(value: AgentEvent): number {
    const result = this.#db.prepare("INSERT INTO events (id, type, task_id, session_id, provider, occurred_at, schema_version, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.type, value.taskId, value.sessionId, value.provider, value.occurredAt, value.schemaVersion, JSON.stringify(value.payload));
    return Number(result.lastInsertRowid);
  }

  listEvents(taskId?: string, afterSequence = 0, limit = 500): Array<AgentEvent & { sequence: number }> {
    const rows = taskId
      ? this.#db.prepare("SELECT * FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT ?").all(taskId, afterSequence, limit)
      : this.#db.prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?").all(afterSequence, limit);
    return rows.map((row) => ({ ...this.#event(row), sequence: Number(row.sequence) }));
  }

  readonly #workspace = (row: Row): Workspace => ({ id: text(row.id), name: text(row.name), rootPath: text(row.root_path), branchPrefix: text(row.branch_prefix), status: text(row.status) as Workspace["status"], createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
  readonly #project = (row: Row): Project => ({ id: text(row.id), name: text(row.name), localPath: text(row.local_path), remoteUrl: text(row.remote_url), baseBranch: text(row.base_branch), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
  readonly #workspaceProject = (row: Row): WorkspaceProject => ({ id: text(row.id), workspaceId: text(row.workspace_id), projectId: text(row.project_id), branch: text(row.branch), worktreePath: text(row.worktree_path), baseBranch: text(row.base_branch), createdAt: text(row.created_at) });
  readonly #task = (row: Row): Task => ({ id: text(row.id), workspaceId: text(row.workspace_id), title: text(row.title), description: text(row.description), status: text(row.status) as Task["status"], reviewRequired: Number(row.review_required) === 1, createdAt: text(row.created_at), updatedAt: text(row.updated_at), startedAt: nullableText(row.started_at), completedAt: nullableText(row.completed_at), cancelledAt: nullableText(row.cancelled_at) });
  readonly #executionProfile = (row: Row): ExecutionProfile => ({ id: text(row.id), name: text(row.name), type: text(row.type) as ExecutionProfile["type"], provider: text(row.provider) as ExecutionProfile["provider"], image: nullableText(row.image), environment: json(row.environment_json, {}), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
  readonly #session = (row: Row): AgentSession => ({ id: text(row.id), taskId: text(row.task_id), provider: text(row.provider) as AgentSession["provider"], executorType: text(row.executor_type) as AgentSession["executorType"], executionProfileId: nullableText(row.execution_profile_id), providerSessionId: nullableText(row.provider_session_id), providerTurnId: nullableText(row.provider_turn_id), runtimeStatus: text(row.runtime_status) as AgentSession["runtimeStatus"], prompt: text(row.prompt), summary: nullableText(row.summary), error: nullableText(row.error), createdAt: text(row.created_at), updatedAt: text(row.updated_at), endedAt: nullableText(row.ended_at) });
  readonly #attempt = (row: Row): SessionAttempt => ({ id: text(row.id), sessionId: text(row.session_id), status: text(row.status) as SessionAttempt["status"], resumed: Number(row.resumed) === 1, providerSessionId: nullableText(row.provider_session_id), error: nullableText(row.error), startedAt: text(row.started_at), updatedAt: text(row.updated_at), endedAt: nullableText(row.ended_at) });
  readonly #agentRun = (row: Row): AgentRun => ({ id: text(row.id), taskId: text(row.task_id), sessionId: text(row.session_id), status: text(row.status) as AgentRun["status"], startedAt: text(row.started_at), endedAt: nullableText(row.ended_at), error: nullableText(row.error) });
  readonly #message = (row: Row): ConversationMessage => ({ id: text(row.id), clientMessageId: text(row.client_message_id), taskId: text(row.task_id), sessionId: text(row.session_id), role: "user", content: text(row.content), status: text(row.status) as ConversationMessage["status"], error: nullableText(row.error), createdAt: text(row.created_at), updatedAt: text(row.updated_at), acceptedAt: nullableText(row.accepted_at) });
  readonly #interaction = (row: Row): InteractionRequest => ({ id: text(row.id), provider: text(row.provider) as InteractionRequest["provider"], providerRequestId: text(row.provider_request_id), taskId: text(row.task_id), sessionId: text(row.session_id), kind: text(row.kind) as InteractionRequest["kind"], title: text(row.title), message: nullableText(row.message), riskLevel: text(row.risk_level) as InteractionRequest["riskLevel"], request: json(row.request_json, {}), availableDecisions: json(row.available_decisions_json, []), status: text(row.status) as InteractionRequest["status"], response: row.response_json ? json(row.response_json, {}) : null, createdAt: text(row.created_at), respondedAt: nullableText(row.responded_at), resolvedAt: nullableText(row.resolved_at) });
  readonly #event = (row: Row): AgentEvent => ({ id: text(row.id), type: text(row.type), taskId: nullableText(row.task_id), sessionId: nullableText(row.session_id), provider: nullableText(row.provider) as AgentEvent["provider"], occurredAt: text(row.occurred_at), schemaVersion: 1, payload: json(row.payload_json, {}) });
}
