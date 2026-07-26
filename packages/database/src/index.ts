import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AgentEvent,
  AgentSession,
  ExecutionProfile,
  InteractionRequest,
  Project,
  Repository,
  Task,
  TaskStatus,
  Workspace,
  WorkspaceRepository,
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
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, local_path TEXT NOT NULL, remote_url TEXT, base_branch TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id, name)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
        review_required INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT,
        completed_at TEXT, cancelled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        root_path TEXT NOT NULL, branch_prefix TEXT NOT NULL, status TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_repositories (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(id), branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL, base_branch TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, repository_id)
      );
      CREATE TABLE IF NOT EXISTS execution_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, provider TEXT NOT NULL,
        image TEXT, environment_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), provider TEXT NOT NULL,
        executor_type TEXT NOT NULL, execution_profile_id TEXT,
        provider_session_id TEXT, provider_turn_id TEXT, runtime_status TEXT NOT NULL,
        prompt TEXT NOT NULL, summary TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
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
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_task ON agent_sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_interactions_task_status ON interactions(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_task_sequence ON events(task_id, sequence);
    `);
  }

  insertProject(value: Project): Project {
    this.#db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)")
      .run(value.id, value.name, value.description, value.createdAt, value.updatedAt);
    return value;
  }

  listProjects(): Project[] {
    return this.#db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all().map(this.#project);
  }

  getProject(id: string): Project | null {
    const row = this.#db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? this.#project(row) : null;
  }

  insertRepository(value: Repository): Repository {
    this.#db.prepare("INSERT INTO repositories VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.projectId, value.name, value.localPath, value.remoteUrl, value.baseBranch, value.createdAt, value.updatedAt);
    return value;
  }

  listRepositories(projectId: string): Repository[] {
    return this.#db.prepare("SELECT * FROM repositories WHERE project_id = ? ORDER BY name").all(projectId).map(this.#repository);
  }

  getRepositories(ids: string[]): Repository[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.#db.prepare(`SELECT * FROM repositories WHERE id IN (${placeholders})`).all(...ids).map(this.#repository);
  }

  insertTask(value: Task): Task {
    this.#db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.projectId, value.title, value.description, value.status, Number(value.reviewRequired), value.createdAt, value.updatedAt, value.startedAt, value.completedAt, value.cancelledAt);
    return value;
  }

  listTasks(projectId?: string): Task[] {
    const rows = projectId
      ? this.#db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
      : this.#db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all();
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

  markTaskStarted(id: string, at: string): void {
    this.#db.prepare("UPDATE tasks SET status = 'in_progress', review_required = 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?").run(at, at, id);
  }

  insertWorkspace(value: Workspace): Workspace {
    this.#db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.taskId, value.rootPath, value.branchPrefix, value.status, value.error, value.createdAt, value.updatedAt);
    return value;
  }

  updateWorkspace(id: string, status: Workspace["status"], error: string | null, at: string): void {
    this.#db.prepare("UPDATE workspaces SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, at, id);
  }

  getWorkspaceByTask(taskId: string): Workspace | null {
    const row = this.#db.prepare("SELECT * FROM workspaces WHERE task_id = ?").get(taskId);
    return row ? this.#workspace(row) : null;
  }

  insertWorkspaceRepository(value: WorkspaceRepository): WorkspaceRepository {
    this.#db.prepare("INSERT INTO workspace_repositories VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.workspaceId, value.repositoryId, value.branch, value.worktreePath, value.baseBranch, value.createdAt);
    return value;
  }

  listWorkspaceRepositories(workspaceId: string): WorkspaceRepository[] {
    return this.#db.prepare("SELECT * FROM workspace_repositories WHERE workspace_id = ? ORDER BY worktree_path").all(workspaceId).map(this.#workspaceRepository);
  }

  deleteWorkspaceRepositories(workspaceId: string): void {
    this.#db.prepare("DELETE FROM workspace_repositories WHERE workspace_id = ?").run(workspaceId);
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
    this.#db.prepare("INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(value.id, value.taskId, value.workspaceId, value.provider, value.executorType, value.executionProfileId, value.providerSessionId, value.providerTurnId, value.runtimeStatus, value.prompt, value.summary, value.error, value.createdAt, value.updatedAt, value.endedAt);
    return value;
  }

  updateSession(id: string, patch: Partial<Pick<AgentSession, "providerSessionId" | "providerTurnId" | "runtimeStatus" | "summary" | "error" | "endedAt">>, at: string): void {
    const current = this.getSession(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: at };
    this.#db.prepare(`UPDATE agent_sessions SET provider_session_id = ?, provider_turn_id = ?, runtime_status = ?, summary = ?, error = ?, updated_at = ?, ended_at = ? WHERE id = ?`)
      .run(next.providerSessionId, next.providerTurnId, next.runtimeStatus, next.summary, next.error, next.updatedAt, next.endedAt, id);
  }

  getSession(id: string): AgentSession | null {
    const row = this.#db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id);
    return row ? this.#session(row) : null;
  }

  listSessions(taskId: string): AgentSession[] {
    return this.#db.prepare("SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY created_at").all(taskId).map(this.#session);
  }

  recoverInterruptedSessions(at: string): AgentSession[] {
    const rows = this.#db.prepare("SELECT * FROM agent_sessions WHERE runtime_status IN ('starting', 'running', 'waiting')").all();
    const sessions = rows.map(this.#session);
    this.#db.prepare("UPDATE agent_sessions SET runtime_status = 'failed', error = 'Gateway restarted while the session was active', updated_at = ?, ended_at = ? WHERE runtime_status IN ('starting', 'running', 'waiting')").run(at, at);
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

  readonly #project = (row: Row): Project => ({ id: text(row.id), name: text(row.name), description: text(row.description), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
  readonly #repository = (row: Row): Repository => ({ id: text(row.id), projectId: text(row.project_id), name: text(row.name), localPath: text(row.local_path), remoteUrl: nullableText(row.remote_url), baseBranch: text(row.base_branch), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
  readonly #task = (row: Row): Task => ({ id: text(row.id), projectId: text(row.project_id), title: text(row.title), description: text(row.description), status: text(row.status) as Task["status"], reviewRequired: Number(row.review_required) === 1, createdAt: text(row.created_at), updatedAt: text(row.updated_at), startedAt: nullableText(row.started_at), completedAt: nullableText(row.completed_at), cancelledAt: nullableText(row.cancelled_at) });
  readonly #workspace = (row: Row): Workspace => ({ id: text(row.id), taskId: text(row.task_id), rootPath: text(row.root_path), branchPrefix: text(row.branch_prefix), status: text(row.status) as Workspace["status"], error: nullableText(row.error), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
  readonly #workspaceRepository = (row: Row): WorkspaceRepository => ({ id: text(row.id), workspaceId: text(row.workspace_id), repositoryId: text(row.repository_id), branch: text(row.branch), worktreePath: text(row.worktree_path), baseBranch: text(row.base_branch), createdAt: text(row.created_at) });
  readonly #executionProfile = (row: Row): ExecutionProfile => ({ id: text(row.id), name: text(row.name), type: text(row.type) as ExecutionProfile["type"], provider: text(row.provider) as ExecutionProfile["provider"], image: nullableText(row.image), environment: json(row.environment_json, {}), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
  readonly #session = (row: Row): AgentSession => ({ id: text(row.id), taskId: text(row.task_id), workspaceId: text(row.workspace_id), provider: text(row.provider) as AgentSession["provider"], executorType: text(row.executor_type) as AgentSession["executorType"], executionProfileId: nullableText(row.execution_profile_id), providerSessionId: nullableText(row.provider_session_id), providerTurnId: nullableText(row.provider_turn_id), runtimeStatus: text(row.runtime_status) as AgentSession["runtimeStatus"], prompt: text(row.prompt), summary: nullableText(row.summary), error: nullableText(row.error), createdAt: text(row.created_at), updatedAt: text(row.updated_at), endedAt: nullableText(row.ended_at) });
  readonly #interaction = (row: Row): InteractionRequest => ({ id: text(row.id), provider: text(row.provider) as InteractionRequest["provider"], providerRequestId: text(row.provider_request_id), taskId: text(row.task_id), sessionId: text(row.session_id), kind: text(row.kind) as InteractionRequest["kind"], title: text(row.title), message: nullableText(row.message), riskLevel: text(row.risk_level) as InteractionRequest["riskLevel"], request: json(row.request_json, {}), availableDecisions: json(row.available_decisions_json, []), status: text(row.status) as InteractionRequest["status"], response: row.response_json ? json(row.response_json, {}) : null, createdAt: text(row.created_at), respondedAt: nullableText(row.responded_at), resolvedAt: nullableText(row.resolved_at) });
  readonly #event = (row: Row): AgentEvent => ({ id: text(row.id), type: text(row.type), taskId: nullableText(row.task_id), sessionId: nullableText(row.session_id), provider: nullableText(row.provider) as AgentEvent["provider"], occurredAt: text(row.occurred_at), schemaVersion: 1, payload: json(row.payload_json, {}) });
}
