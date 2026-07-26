import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createApp } from "./app.js";
import { AgentBoardRuntime } from "./runtime.js";

describe("Daemon API", () => {
  it("creates projects and tasks and returns board aggregates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-api-"));
    const runtime = new AgentBoardRuntime({
      host: "127.0.0.1", listenHost: "127.0.0.1", port: 4310, dataDirectory: join(directory, "data"),
      workspaceRoot: join(directory, "workspaces"), obsidianVault: null, publicDirectory: null, hookToken: "test-hook-token",
    });
    const app = await createApp(runtime);
    const projectResponse = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Project", description: "" } });
    assert.equal(projectResponse.statusCode, 201);
    const project = projectResponse.json<{ id: string }>();
    const taskResponse = await app.inject({
      method: "POST", url: "/api/tasks",
      payload: { projectId: project.id, title: "Task", description: "Test" },
    });
    assert.equal(taskResponse.statusCode, 201);
    const boardResponse = await app.inject({ method: "GET", url: `/api/tasks?projectId=${project.id}` });
    assert.equal(boardResponse.statusCode, 200);
    assert.equal(boardResponse.json<{ items: unknown[] }>().items.length, 1);
    const unauthenticatedHook = await app.inject({ method: "POST", url: "/api/hooks/claude?sessionId=missing", payload: {} });
    assert.equal(unauthenticatedHook.statusCode, 401);
    const authenticatedHook = await app.inject({
      method: "POST", url: "/api/hooks/claude?sessionId=missing", payload: {},
      headers: { authorization: "Bearer test-hook-token" },
    });
    assert.equal(authenticatedHook.statusCode, 500);
    await app.close();
  });
});
