import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentAdapter, AgentSessionHandle, StartAgentInput } from "@agents-workspaces/agent-core";
import type { AgentSession } from "@agents-workspaces/core";
import { AgentBoardRuntime } from "./runtime.js";

class ResumableCodexAdapter implements AgentAdapter {
  readonly provider = "codex" as const;
  running = false;
  failStart = false;
  starts: StartAgentInput[] = [];
  messages: string[] = [];

  isRunning(): boolean { return this.running; }
  async checkInstallation() { return { installed: true }; }
  async start(input: StartAgentInput): Promise<AgentSessionHandle> {
    this.starts.push(input);
    if (this.failStart) throw new Error("resume rejected");
    this.running = true;
    return { sessionId: input.sessionId, providerSessionId: input.providerSessionId ?? "thread-new", provider: "codex" };
  }
  async sendMessage(_sessionId: string, message: string): Promise<void> { this.messages.push(message); }
  async interrupt(): Promise<void> {}
  async terminate(): Promise<void> { this.running = false; }
}

describe("AgentBoardRuntime message recovery", () => {
  it("resumes a persisted Provider session and only stores accepted user messages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-resume-"));
    const adapter = new ResumableCodexAdapter();
    const runtime = new AgentBoardRuntime({
      host: "127.0.0.1", listenHost: "127.0.0.1", port: 4310,
      dataDirectory: join(directory, "data"), workspaceRoot: join(directory, "workspaces"),
      obsidianVault: null, publicDirectory: null, hookToken: "test-hook-token",
    }, { codex: adapter });
    const project = runtime.createProject({ name: "Project", description: "" });
    const task = runtime.createTask({ projectId: project.id, title: "Task", description: "Test" });
    const at = new Date().toISOString();
    runtime.db.insertWorkspace({
      id: "workspace-resume", taskId: task.id, rootPath: directory, branchPrefix: "test/resume",
      status: "ready", error: null, createdAt: at, updatedAt: at,
    });
    const session: AgentSession = {
      id: "session-resume", taskId: task.id, workspaceId: "workspace-resume", provider: "codex",
      executorType: "native", executionProfileId: null, providerSessionId: "thread-existing",
      providerTurnId: null, runtimeStatus: "failed", prompt: "Initial", summary: null,
      error: "Gateway restarted", createdAt: at, updatedAt: at, endedAt: at,
    };
    runtime.db.insertSession(session);

    await runtime.sendMessage(session.id, "Continue once", "client-once");
    await runtime.sendMessage(session.id, "Continue once", "client-once");

    assert.equal(adapter.starts.length, 1);
    assert.equal(adapter.starts[0]?.providerSessionId, "thread-existing");
    assert.equal(runtime.db.getSession(session.id)?.runtimeStatus, "running");
    const accepted = runtime.db.listEvents(task.id).filter((event) =>
      event.type === "TEXT_MESSAGE_CONTENT" && (event.payload as { delta?: string }).delta === "Continue once");
    assert.equal(accepted.length, 1);
    assert.equal(runtime.db.getMessageByClientId("client-once")?.status, "accepted");
    assert.equal(runtime.db.listAttempts(session.id).length, 1);

    adapter.running = false;
    adapter.failStart = true;
    await assert.rejects(runtime.sendMessage(session.id, "Do not persist", "client-failed"), /resume rejected/);
    const rejected = runtime.db.listEvents(task.id).filter((event) =>
      event.type === "TEXT_MESSAGE_CONTENT" && (event.payload as { delta?: string }).delta === "Do not persist");
    assert.equal(rejected.length, 0);
    assert.equal(runtime.db.getMessageByClientId("client-failed")?.status, "failed");
    assert.equal(runtime.db.getTask(task.id)?.status, "needs_attention");
    runtime.close();
  });

  it("restores history after a daemon restart and resumes with the persisted Provider id", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-daemon-restart-"));
    const config = {
      host: "127.0.0.1", listenHost: "127.0.0.1", port: 4310,
      dataDirectory: join(directory, "data"), workspaceRoot: join(directory, "workspaces"),
      obsidianVault: null, publicDirectory: null, hookToken: "test-hook-token",
    };
    const firstAdapter = new ResumableCodexAdapter();
    const first = new AgentBoardRuntime(config, { codex: firstAdapter });
    const project = first.createProject({ name: "Restart", description: "" });
    const task = first.createTask({ projectId: project.id, title: "Persistent task", description: "History" });
    const at = new Date().toISOString();
    first.db.insertWorkspace({ id: "workspace-restart", taskId: task.id, rootPath: directory, branchPrefix: "test/restart", status: "ready", error: null, createdAt: at, updatedAt: at });
    const session: AgentSession = { id: "session-restart", taskId: task.id, workspaceId: "workspace-restart", provider: "codex", executorType: "native", executionProfileId: null, providerSessionId: "thread-restart", providerTurnId: null, runtimeStatus: "running", prompt: "Initial", summary: null, error: null, createdAt: at, updatedAt: at, endedAt: null };
    first.db.insertSession(session);
    first.db.insertAttempt({ id: "attempt-before-restart", sessionId: session.id, status: "running", resumed: false, providerSessionId: "thread-restart", error: null, startedAt: at, updatedAt: at, endedAt: null });
    first.emit({ type: "TEXT_MESSAGE_CONTENT", taskId: task.id, sessionId: session.id, provider: "codex", payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "history", role: "assistant", delta: "Persisted answer" } });
    first.close();

    const resumedAdapter = new ResumableCodexAdapter();
    const second = new AgentBoardRuntime(config, { codex: resumedAdapter });
    assert.equal(second.db.getSession(session.id)?.runtimeStatus, "suspended");
    assert.equal(second.db.getTask(task.id)?.status, "needs_attention");
    assert.equal(second.db.listEvents(task.id).some((event) => JSON.stringify(event.payload).includes("Persisted answer")), true);

    await second.sendMessage(session.id, "Continue after restart", "client-after-restart");
    assert.equal(resumedAdapter.starts[0]?.providerSessionId, "thread-restart");
    assert.equal(second.db.getSession(session.id)?.runtimeStatus, "running");
    assert.equal(second.db.listAttempts(session.id).length, 2);
    second.close();
  });
});
