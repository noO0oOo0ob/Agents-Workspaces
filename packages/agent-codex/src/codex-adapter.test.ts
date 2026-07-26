import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agents-workspaces/core";
import type { Executor, ProcessExit, ProcessHandle, SpawnInput } from "@agents-workspaces/executor-core";
import { CodexAdapter } from "./index.js";

class FakeProcess implements ProcessHandle {
  readonly id = "session-test";
  readonly pid = 1;
  readonly writes: Array<Record<string, unknown>> = [];
  readonly events = new EventEmitter();

  write(data: string | Uint8Array): boolean {
    const message = JSON.parse(String(data).trim()) as Record<string, unknown>;
    this.writes.push(message);
    if (message.id && message.method === "initialize") this.respond(message.id, { userAgent: "fake" });
    if (message.id && message.method === "thread/start") this.respond(message.id, { thread: { id: "thread-1" } });
    if (message.id && message.method === "turn/start") this.respond(message.id, { turn: { id: "turn-1" } });
    return true;
  }
  respond(id: unknown, result: unknown): void { queueMicrotask(() => this.events.emit("output", "stdout", `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)); }
  serverRequest(message: Record<string, unknown>): void { this.events.emit("output", "stdout", `${JSON.stringify(message)}\n`); }
  interrupt(): void {}
  terminate(): void {}
  onOutput(listener: (stream: "stdout" | "stderr", data: string) => void): () => void { this.events.on("output", listener); return () => this.events.off("output", listener); }
  onExit(listener: (exit: ProcessExit) => void): () => void { this.events.on("exit", listener); return () => this.events.off("exit", listener); }
}

class FakeExecutor implements Executor {
  readonly type = "native" as const;
  readonly process = new FakeProcess();
  async checkHealth() { return { ready: true }; }
  async spawn(_input: SpawnInput) { return this.process; }
  get() { return this.process; }
  async terminate() {}
}

describe("CodexAdapter", () => {
  it("starts App Server and routes approval requests", async () => {
    const events: AgentEvent[] = [];
    const executor = new FakeExecutor();
    const adapter = new CodexAdapter({
      emit: (event) => events.push({ ...event, id: "event", occurredAt: new Date().toISOString(), schemaVersion: 1 }),
      requestInteraction: async (_sessionId, input) => {
        assert.equal(input.kind, "command_approval");
        return { decision: "accept" };
      },
    });
    const handle = await adapter.start({
      sessionId: "session-test", taskId: "task-test", workspacePath: "/tmp/workspace",
      prompt: "Implement", executor, gatewayUrl: "http://127.0.0.1:4310",
    });
    assert.equal(handle.providerSessionId, "thread-1");
    executor.process.serverRequest({
      jsonrpc: "2.0", id: 99, method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "npm test" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const response = executor.process.writes.find((message) => message.id === 99);
    assert.deepEqual(response?.result, { decision: "accept" });
    assert.ok(events.some((event) => event.type === "session.started"));
  });
});

