import type { BaseEvent } from "@ag-ui/core";

export type AgentProvider = "codex" | "claude";
export type ExecutorType = "native" | "docker";
export type TaskStatus =
  | "todo"
  | "in_progress"
  | "needs_attention"
  | "in_review"
  | "done"
  | "cancelled"
  | "archived";
export type SessionRuntimeStatus = "starting" | "running" | "waiting" | "suspended" | "stopped" | "failed";
export type SessionAttemptStatus = "starting" | "running" | "waiting" | "idle" | "completed" | "failed" | "interrupted" | "stopped";
export type ConversationMessageStatus = "queued" | "submitting" | "accepted" | "failed";
export type InteractionStatus = "pending" | "responded" | "resolved" | "stale" | "cancelled";
export type InteractionKind =
  | "command_approval"
  | "file_approval"
  | "permission_request"
  | "question"
  | "choice"
  | "form";

/** A durable multi-repository work area. */
export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  branchPrefix: string;
  status: "ready" | "archived";
  createdAt: string;
  updatedAt: string;
}

/** A managed Git clone that can be mounted into a Workspace as a worktree. */
export interface Project {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceProject {
  id: string;
  workspaceId: string;
  projectId: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  createdAt: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: TaskStatus;
  reviewRequired: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface ExecutionProfile {
  id: string;
  name: string;
  type: ExecutorType;
  provider: AgentProvider;
  image: string | null;
  environment: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  taskId: string;
  provider: AgentProvider;
  executorType: ExecutorType;
  executionProfileId: string | null;
  providerSessionId: string | null;
  providerTurnId: string | null;
  runtimeStatus: SessionRuntimeStatus;
  prompt: string;
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/**
 * A user-visible execution of an Agent Thread. A Task is the durable Thread;
 * Provider sessions are implementation details that can be restarted or
 * resumed without changing the Thread identity.
 */
export interface AgentRun {
  id: string;
  taskId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface SessionAttempt {
  id: string;
  sessionId: string;
  status: SessionAttemptStatus;
  resumed: boolean;
  providerSessionId: string | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface ConversationMessage {
  id: string;
  clientMessageId: string;
  taskId: string;
  sessionId: string;
  role: "user";
  content: string;
  status: ConversationMessageStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}

export interface InteractionOption {
  label: string;
  value: string;
  description?: string;
}

export interface InteractionRequest {
  id: string;
  provider: AgentProvider;
  providerRequestId: string;
  taskId: string;
  sessionId: string;
  kind: InteractionKind;
  title: string;
  message: string | null;
  riskLevel: "low" | "medium" | "high";
  request: Record<string, unknown>;
  availableDecisions: string[];
  status: InteractionStatus;
  response: Record<string, unknown> | null;
  createdAt: string;
  respondedAt: string | null;
  resolvedAt: string | null;
}

export interface AgentEvent<TPayload = unknown> {
  id: string;
  type: string;
  taskId: string | null;
  sessionId: string | null;
  provider: AgentProvider | null;
  occurredAt: string;
  schemaVersion: 1;
  payload: TPayload;
}

export type AgUiEvent = BaseEvent;
export type AgentStreamEvent = AgentEvent<AgUiEvent>;

export function isAgUiEvent(value: unknown): value is AgUiEvent {
  return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string");
}

export type DomainEvent<TPayload = unknown> = AgentEvent<TPayload>;

export interface RepositoryChanges {
  repositoryId: string;
  repositoryName: string;
  worktreePath: string;
  status: string;
  diff: string;
  diffStat: string;
  commits: string[];
}

export interface TaskStatusFacts {
  hasStarted: boolean;
  reviewRequired: boolean;
  completedAt?: string;
  cancelledAt?: string;
  sessions: Array<{ runtimeStatus: SessionRuntimeStatus }>;
  interactions: Array<{ status: InteractionStatus }>;
}

export function deriveTaskStatus(task: TaskStatusFacts): TaskStatus {
  if (task.cancelledAt) return "cancelled";
  if (task.completedAt) return "done";
  if (task.interactions.some((interaction) => interaction.status === "pending")) {
    return "needs_attention";
  }
  if (task.sessions.some((session) => session.runtimeStatus === "failed")) {
    return "needs_attention";
  }
  if (task.sessions.some((session) => session.runtimeStatus === "suspended")) {
    return "needs_attention";
  }
  if (task.sessions.some((session) =>
    session.runtimeStatus === "starting" ||
    session.runtimeStatus === "running" ||
    session.runtimeStatus === "waiting")) {
    return "in_progress";
  }
  if (task.hasStarted && task.reviewRequired) return "in_review";
  return "todo";
}

export function now(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
