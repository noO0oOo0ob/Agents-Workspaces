import type { AgentProvider, InteractionStatus } from "@agents-workspaces/core";

export type InteractionKind =
  | "command_approval"
  | "file_approval"
  | "permission_request"
  | "question"
  | "choice"
  | "form";

export interface InteractionRequest {
  id: string;
  provider: AgentProvider;
  providerRequestId: string;
  taskId: string;
  sessionId: string;
  kind: InteractionKind;
  title: string;
  message?: string;
  status: InteractionStatus;
  createdAt: string;
}

export class InteractionRegistry {
  readonly #requests = new Map<string, InteractionRequest>();

  add(request: InteractionRequest): InteractionRequest {
    const duplicate = [...this.#requests.values()].find(
      (existing) => existing.provider === request.provider && existing.providerRequestId === request.providerRequestId,
    );
    if (duplicate) return duplicate;
    this.#requests.set(request.id, request);
    return request;
  }

  pending(): InteractionRequest[] {
    return [...this.#requests.values()].filter((request) => request.status === "pending");
  }
}

