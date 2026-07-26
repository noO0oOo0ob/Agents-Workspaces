import type { AgentEvent, AgentProvider, InteractionKind } from "@agents-workspaces/core";
import type { Executor } from "@agents-workspaces/executor-core";

export interface AgentSessionHandle {
  sessionId: string;
  providerSessionId: string | null;
  provider: AgentProvider;
}

export interface StartAgentInput {
  sessionId: string;
  taskId: string;
  workspacePath: string;
  prompt: string;
  executor: Executor;
  image?: string;
  environment?: Record<string, string>;
  gatewayUrl: string;
  hookToken?: string;
  providerSessionId?: string;
}

export interface AdapterInteractionInput {
  providerRequestId: string;
  kind: InteractionKind;
  title: string;
  message?: string | undefined;
  riskLevel: "low" | "medium" | "high";
  request: Record<string, unknown>;
  availableDecisions: string[];
}

export interface AgentAdapterHooks {
  emit(event: Omit<AgentEvent, "id" | "occurredAt" | "schemaVersion">): void;
  requestInteraction(sessionId: string, input: AdapterInteractionInput): Promise<Record<string, unknown>>;
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  checkInstallation(): Promise<{ installed: boolean; version?: string; error?: string }>;
  start(input: StartAgentInput): Promise<AgentSessionHandle>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;
}
