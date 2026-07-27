import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agents-workspaces/core";
import type { Executor, ProcessExit, ProcessHandle, SpawnInput } from "@agents-workspaces/executor-core";
import { ClaudeAdapter } from "./index.js";

class FakeClaudeProcess implements ProcessHandle {
  readonly id = "session-test";
  readonly pid = 1;
  readonly writes: string[] = [];
  readonly events = new EventEmitter();
  write(data: string | Uint8Array): boolean { this.writes.push(String(data)); return true; }
  interrupt(): void {}
  terminate(): void {}
  onOutput(listener: (stream: "stdout" | "stderr", data: string) => void): () => void { this.events.on("output", listener); return () => this.events.off("output", listener); }
  onExit(listener: (exit: ProcessExit) => void): () => void { this.events.on("exit", listener); return () => this.events.off("exit", listener); }
}

class FakeClaudeExecutor implements Executor {
  readonly type = "native" as const;
  readonly process = new FakeClaudeProcess();
  spawnInput: SpawnInput | null = null;
  async checkHealth() { return { ready: true }; }
  async spawn(input: SpawnInput) { this.spawnInput = input; return this.process; }
  get() { return this.process; }
  async terminate() {}
}

describe("ClaudeAdapter", () => {
  it("starts stream-json mode and emits result events", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "agents-workspaces-claude-"));
    const events: AgentEvent[] = [];
    const executor = new FakeClaudeExecutor();
    const adapter = new ClaudeAdapter({
      emit: (event) => events.push({ ...event, id: "event", occurredAt: new Date().toISOString(), schemaVersion: 1 }),
      requestInteraction: async () => ({}),
    });
    const handle = await adapter.start({
      sessionId: "session-test", taskId: "task-test", workspacePath,
      prompt: "Implement", executor, gatewayUrl: "http://127.0.0.1:4310", hookToken: "secret",
    });
    assert.equal(handle.provider, "claude");
    assert.ok(executor.spawnInput?.args.includes("stream-json"));
    assert.equal(executor.spawnInput?.env?.AGENTS_WORKSPACES_HOOK_TOKEN, "secret");
    const settings = readFileSync(join(workspacePath, ".agents-workspaces", "claude-settings.json"), "utf8");
    assert.match(settings, /Bearer \$AGENTS_WORKSPACES_HOOK_TOKEN/);
    assert.match(executor.process.writes[0] ?? "", /Implement/);
    executor.process.events.emit("output", "stdout", `${JSON.stringify({ type: "system", session_id: "claude-session-1" })}\n`);
    executor.process.events.emit("output", "stdout", `${JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "Hello" } },
    })}\n`);
    executor.process.events.emit("output", "stdout", `${JSON.stringify({ type: "result", is_error: false, result: "done" })}\n`);
    assert.ok(events.some((event) => event.type === "RUN_STARTED"));
    assert.ok(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && (event.payload as { delta?: string }).delta === "Hello"));
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
  });
});
