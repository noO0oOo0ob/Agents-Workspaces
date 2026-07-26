import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createId, now } from "@agents-workspaces/core";
import { AppDatabase } from "./index.js";

describe("AppDatabase", () => {
  it("persists a project, task, workspace and session", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-db-"));
    const db = new AppDatabase(join(directory, "test.sqlite"));
    const at = now();
    const project = db.insertProject({ id: createId("project"), name: "Test", description: "", createdAt: at, updatedAt: at });
    const task = db.insertTask({
      id: createId("task"), projectId: project.id, title: "Cross-repo change", description: "",
      status: "todo", reviewRequired: false, createdAt: at, updatedAt: at,
      startedAt: null, completedAt: null, cancelledAt: null,
    });
    const workspace = db.insertWorkspace({
      id: createId("workspace"), taskId: task.id, rootPath: join(directory, "workspace"),
      branchPrefix: `agent/${task.id}`, status: "ready", error: null, createdAt: at, updatedAt: at,
    });
    const session = db.insertSession({
      id: createId("session"), taskId: task.id, workspaceId: workspace.id, provider: "codex",
      executorType: "native", executionProfileId: null, providerSessionId: null, providerTurnId: null,
      runtimeStatus: "starting", prompt: "Implement", summary: null, error: null,
      createdAt: at, updatedAt: at, endedAt: null,
    });
    const attempt = db.insertAttempt({
      id: createId("attempt"), sessionId: session.id, status: "running", resumed: false,
      providerSessionId: "thread-1", error: null, startedAt: at, updatedAt: at, endedAt: null,
    });
    const message = db.insertMessage({
      id: createId("message"), clientMessageId: "client-1", taskId: task.id, sessionId: session.id,
      role: "user", content: "Implement", status: "accepted", error: null,
      createdAt: at, updatedAt: at, acceptedAt: at,
    });

    assert.equal(db.getProject(project.id)?.name, "Test");
    assert.equal(db.getTask(task.id)?.status, "todo");
    assert.equal(db.getWorkspaceByTask(task.id)?.status, "ready");
    assert.equal(db.getSession(session.id)?.provider, "codex");
    assert.equal(db.latestAttempt(session.id)?.id, attempt.id);
    assert.equal(db.getMessageByClientId("client-1")?.id, message.id);
    db.close();
  });

  it("marks live processes as resumable while preserving their Provider session", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-db-recovery-"));
    const db = new AppDatabase(join(directory, "test.sqlite"));
    const at = now();
    const project = db.insertProject({ id: createId("project"), name: "Recovery", description: "", createdAt: at, updatedAt: at });
    const task = db.insertTask({ id: createId("task"), projectId: project.id, title: "Resume", description: "", status: "in_progress", reviewRequired: true, createdAt: at, updatedAt: at, startedAt: at, completedAt: null, cancelledAt: null });
    const workspace = db.insertWorkspace({ id: createId("workspace"), taskId: task.id, rootPath: directory, branchPrefix: "agent/resume", status: "ready", error: null, createdAt: at, updatedAt: at });
    const session = db.insertSession({ id: createId("session"), taskId: task.id, workspaceId: workspace.id, provider: "codex", executorType: "native", executionProfileId: null, providerSessionId: "thread-persisted", providerTurnId: null, runtimeStatus: "running", prompt: "Start", summary: null, error: null, createdAt: at, updatedAt: at, endedAt: null });
    const attempt = db.insertAttempt({ id: createId("attempt"), sessionId: session.id, status: "running", resumed: false, providerSessionId: "thread-persisted", error: null, startedAt: at, updatedAt: at, endedAt: null });

    db.recoverInterruptedSessions(now());

    assert.equal(db.getSession(session.id)?.runtimeStatus, "suspended");
    assert.equal(db.getSession(session.id)?.providerSessionId, "thread-persisted");
    assert.equal(db.getAttempt(attempt.id)?.status, "interrupted");
    db.close();
  });
});
