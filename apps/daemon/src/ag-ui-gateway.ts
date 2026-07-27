import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentEvent } from "@agents-workspaces/core";
import { AgentBoardRuntime } from "./runtime.js";

const runInputSchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1),
  messages: z.array(z.unknown()).default([]),
}).passthrough();

const threadParamsSchema = z.object({ id: z.string().min(1) });

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface StreamEvent {
  type: string;
  threadId?: string;
  runId?: string;
  [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      const item = record(part);
      return typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
    }).join("");
  }
  const item = record(value);
  return typeof item.text === "string" ? item.text : "";
}

/** Extracts the actual new user input from the standard AG-UI message list. */
export function latestUserText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message.role !== "user") continue;
    const text = textContent(message.content).trim();
    if (text) return text;
  }
  return null;
}

/**
 * Creates a small, durable read model for initial UI hydration. Live messages
 * are then owned by the AG-UI client rather than by a bespoke event reducer.
 */
export function threadMessages(events: Array<AgentEvent & { sequence: number }>): ThreadMessage[] {
  const messages = new Map<string, ThreadMessage>();
  const order: string[] = [];
  const ensure = (id: string, role: "user" | "assistant") => {
    const current = messages.get(id);
    if (current) return current;
    const next = { id, role, content: "" };
    messages.set(id, next);
    order.push(id);
    return next;
  };

  for (const event of events) {
    const payload = record(event.payload);
    const type = typeof payload.type === "string" ? payload.type : event.type;
    if (type === "TEXT_MESSAGE_START") {
      const id = typeof payload.messageId === "string" ? payload.messageId : event.id;
      ensure(id, payload.role === "user" ? "user" : "assistant");
      continue;
    }
    if (type === "TEXT_MESSAGE_CONTENT" || type === "TEXT_MESSAGE_CHUNK") {
      const id = typeof payload.messageId === "string" ? payload.messageId : event.id;
      const message = ensure(id, payload.role === "user" ? "user" : "assistant");
      message.content += typeof payload.delta === "string" ? payload.delta : textContent(payload.content);
    }
  }
  return order.map((id) => messages.get(id)).filter((value): value is ThreadMessage => Boolean(value && value.content));
}

function isAgUiPayload(event: AgentEvent): event is AgentEvent<StreamEvent> {
  return Boolean(event.payload && typeof event.payload === "object" && typeof (event.payload as { type?: unknown }).type === "string");
}

function normalizeRunEvent(event: StreamEvent, threadId: string, runId: string): StreamEvent {
  if (event.type === "RUN_STARTED" || event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
    return { ...event, threadId, runId };
  }
  return event;
}

function eventForStream(event: AgentEvent, threadId: string, runId: string): StreamEvent | null {
  if (isAgUiPayload(event)) return normalizeRunEvent(event.payload, threadId, runId);
  if (event.type === "session.error" || event.type === "session.failed") {
    return { type: "RUN_ERROR", threadId, runId, message: record(event.payload).message ?? JSON.stringify(event.payload) };
  }
  if (event.type === "session.ended") return { type: "RUN_FINISHED", threadId, runId };
  return null;
}

function sse(reply: FastifyReply, event: StreamEvent): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function parseInput(request: FastifyRequest): z.infer<typeof runInputSchema> {
  const result = runInputSchema.safeParse(request.body);
  if (!result.success) throw Object.assign(new Error("Invalid AG-UI run input"), { statusCode: 400 });
  return result.data;
}

export function registerAgUiGateway(app: FastifyInstance, runtime: AgentBoardRuntime): void {
  app.get("/api/agent/threads/:id", async (request) => {
    const result = threadParamsSchema.safeParse(request.params);
    if (!result.success) throw Object.assign(new Error("Invalid thread id"), { statusCode: 400 });
    const task = runtime.db.getTask(result.data.id);
    if (!task) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
    const events = runtime.db.listEvents(task.id, 0, 100_000);
    return {
      threadId: task.id,
      messages: threadMessages(events),
      runs: runtime.db.listAgentRuns(task.id),
      sequence: events.at(-1)?.sequence ?? 0,
    };
  });

  app.post("/api/agent/run", async (request, reply) => {
    const input = parseInput(request);
    const task = runtime.db.getTask(input.threadId);
    if (!task) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
    const session = runtime.db.listSessions(task.id).at(-1);
    if (!session) throw Object.assign(new Error("Task has no Agent session"), { statusCode: 400 });
    const message = latestUserText(input.messages);
    if (!message) throw Object.assign(new Error("A user message is required"), { statusCode: 400 });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.flushHeaders?.();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    const unsubscribe = runtime.subscribe((event) => {
      if (closed || event.taskId !== task.id || event.sessionId !== session.id) return;
      const streamEvent = eventForStream(event, input.threadId, input.runId);
      if (!streamEvent) return;
      sse(reply, streamEvent);
      if (streamEvent.type === "RUN_FINISHED") {
        runtime.completeAgentRun(input.runId, "completed");
        close();
      } else if (streamEvent.type === "RUN_ERROR") {
        runtime.completeAgentRun(input.runId, "failed", typeof streamEvent.message === "string" ? streamEvent.message : "Agent run failed");
        close();
      }
    });
    request.raw.once("close", close);

    try {
      await runtime.runTaskMessage(task.id, input.runId, message);
    } catch (error) {
      if (!closed) {
        sse(reply, {
          type: "RUN_ERROR", threadId: input.threadId, runId: input.runId,
          message: error instanceof Error ? error.message : String(error),
        });
        close();
      }
    }
  });
}
