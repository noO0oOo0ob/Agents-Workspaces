import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createId, now } from "@agents-workspaces/core";
import { AppDatabase } from "./index.js";

describe("AppDatabase", () => {
  it("persists the Workspace-first task model", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-db-"));
    const db = new AppDatabase(join(directory, "test.sqlite"));
    const at = now();
    const workspace = db.insertWorkspace({
      id: createId("workspace"), name: "Payments", rootPath: join(directory, "workspace"),
      branchPrefix: "workspace/payments", status: "ready", createdAt: at, updatedAt: at,
    });
    const project = db.insertProject({
      id: createId("project"), name: "api", localPath: join(directory, "cache", "api"), remoteUrl: "https://example.test/api.git",
      baseBranch: "main", createdAt: at, updatedAt: at,
    });
    db.insertWorkspaceProject({
      id: createId("workspaceProject"), workspaceId: workspace.id, projectId: project.id, branch: workspace.branchPrefix,
      worktreePath: join(workspace.rootPath, "api"), baseBranch: "main", createdAt: at,
    });
    const task = db.insertTask({
      id: createId("task"), workspaceId: workspace.id, title: "Cross-repo change", description: "",
      status: "todo", reviewRequired: false, createdAt: at, updatedAt: at,
      startedAt: null, completedAt: null, cancelledAt: null,
    });
    const session = db.insertSession({
      id: createId("session"), taskId: task.id, provider: "codex", executorType: "native",
      executionProfileId: null, providerSessionId: null, providerTurnId: null,
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

    assert.equal(db.getWorkspace(workspace.id)?.name, "Payments");
    assert.equal(db.getProjects([project.id])[0]?.name, "api");
    assert.equal(db.listWorkspaceProjects(workspace.id).length, 1);
    assert.equal(db.listTasks(workspace.id)[0]?.id, task.id);
    assert.equal(db.getSession(session.id)?.provider, "codex");
    assert.equal(db.latestAttempt(session.id)?.id, attempt.id);
    assert.equal(db.getMessageByClientId("client-1")?.id, message.id);
    db.close();
  });

  it("marks live Provider sessions resumable after a restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-db-recovery-"));
    const db = new AppDatabase(join(directory, "test.sqlite"));
    const at = now();
    const workspace = db.insertWorkspace({ id: createId("workspace"), name: "Recovery", rootPath: directory, branchPrefix: "workspace/recovery", status: "ready", createdAt: at, updatedAt: at });
    const task = db.insertTask({ id: createId("task"), workspaceId: workspace.id, title: "Resume", description: "", status: "in_progress", reviewRequired: true, createdAt: at, updatedAt: at, startedAt: at, completedAt: null, cancelledAt: null });
    const session = db.insertSession({ id: createId("session"), taskId: task.id, provider: "codex", executorType: "native", executionProfileId: null, providerSessionId: "thread-persisted", providerTurnId: null, runtimeStatus: "running", prompt: "Start", summary: null, error: null, createdAt: at, updatedAt: at, endedAt: null });
    const attempt = db.insertAttempt({ id: createId("attempt"), sessionId: session.id, status: "running", resumed: false, providerSessionId: "thread-persisted", error: null, startedAt: at, updatedAt: at, endedAt: null });

    db.recoverInterruptedSessions(now());

    assert.equal(db.getSession(session.id)?.runtimeStatus, "suspended");
    assert.equal(db.getSession(session.id)?.providerSessionId, "thread-persisted");
    assert.equal(db.getAttempt(attempt.id)?.status, "interrupted");
    db.close();
  });
});
