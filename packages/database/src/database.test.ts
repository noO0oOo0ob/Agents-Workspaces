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

    assert.equal(db.getProject(project.id)?.name, "Test");
    assert.equal(db.getTask(task.id)?.status, "todo");
    assert.equal(db.getWorkspaceByTask(task.id)?.status, "ready");
    assert.equal(db.getSession(session.id)?.provider, "codex");
    db.close();
  });
});

