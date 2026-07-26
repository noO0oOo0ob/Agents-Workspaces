import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("creates Workspace-first Projects and multiple Agent Tasks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-source-api-"));
    const source = join(directory, "sample-project");
    const remote = join(directory, "sample-project.git");
    mkdirSync(source);
    execFileSync("git", ["init", "-b", "main"], { cwd: source });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: source });
    writeFileSync(join(source, "README.md"), "# sample\n");
    execFileSync("git", ["add", "README.md"], { cwd: source });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: source });
    execFileSync("git", ["clone", "--bare", source, remote]);
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: source });

    const runtime = new AgentBoardRuntime({
      host: "127.0.0.1", listenHost: "127.0.0.1", port: 4310, dataDirectory: join(directory, "data"),
      workspaceRoot: join(directory, "workspaces"), obsidianVault: null, publicDirectory: null, hookToken: "test-hook-token",
    });
    const app = await createApp(runtime);
    const workspacePath = join(directory, "workspaces", "feature-a");
    const workspaceResponse = await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Feature A", rootPath: workspacePath } });
    assert.equal(workspaceResponse.statusCode, 201, workspaceResponse.body);
    const workspace = workspaceResponse.json<{ id: string; rootPath: string; branchPrefix: string }>();
    assert.ok(existsSync(workspace.rootPath));
    const invalidLocalAdd = await app.inject({
      method: "POST", url: `/api/workspaces/${workspace.id}/projects`,
      payload: { sourceType: "local", localPath: join(directory, "not-a-repository") },
    });
    assert.equal(invalidLocalAdd.statusCode, 400);
    assert.match(invalidLocalAdd.json<{ message: string }>().message, /Local repository is invalid/);
    const localAdd = await app.inject({
      method: "POST", url: `/api/workspaces/${workspace.id}/projects`,
      payload: { sourceType: "local", localPath: source },
    });
    assert.equal(localAdd.statusCode, 201, localAdd.body);
    const localWorktree = localAdd.json<{ link: { worktreePath: string } }>().link.worktreePath;
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: localWorktree, encoding: "utf8" }).trim(), workspace.branchPrefix);
    assert.notEqual(execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: localWorktree, encoding: "utf8" }).trim(), join(source, ".git"));

    const createTask = async (title: string) => app.inject({
      method: "POST", url: `/api/workspaces/${workspace.id}/tasks`,
      payload: { title, prompt: `Work on ${title}`, provider: "codex", executorType: "native", startImmediately: false },
    });
    const firstTask = await createTask("Frontend");
    const secondTask = await createTask("Backend");
    assert.equal(firstTask.statusCode, 201, firstTask.body);
    assert.equal(secondTask.statusCode, 201, secondTask.body);
    const firstTaskId = firstTask.json<{ task: { id: string } }>().task.id;
    const secondTaskId = secondTask.json<{ task: { id: string } }>().task.id;
    const summaries = await app.inject({ method: "GET", url: "/api/workspaces" });
    const summaryTask = summaries.json<{ items: Array<{ tasks: Array<{ events: unknown[] }> }> }>().items[0]?.tasks[0];
    assert.deepEqual(summaryTask?.events, []);
    const taskDetails = await app.inject({ method: "GET", url: `/api/tasks/${firstTaskId}` });
    assert.ok(taskDetails.json<{ events: unknown[] }>().events.length > 0);

    const insertTestSession = (taskId: string, id: string) => {
      const runtimeWorkspace = runtime.db.getWorkspaceByTask(taskId);
      assert.ok(runtimeWorkspace);
      const at = new Date().toISOString();
      runtime.db.markTaskStarted(taskId, at);
      runtime.db.insertSession({
        id, taskId, workspaceId: runtimeWorkspace.id, provider: "codex", executorType: "native",
        executionProfileId: null, providerSessionId: "thread-test", providerTurnId: null,
        runtimeStatus: "starting", prompt: "Test AG-UI state", summary: null, error: null,
        createdAt: at, updatedAt: at, endedAt: null,
      });
    };
    insertTestSession(firstTaskId, "session-ag-ui-success");
    runtime.emit({
      type: "RUN_STARTED", taskId: firstTaskId, sessionId: "session-ag-ui-success", provider: "codex",
      payload: { type: "RUN_STARTED", threadId: "thread-test", runId: "run-test" },
    });
    assert.equal(runtime.db.getSession("session-ag-ui-success")?.runtimeStatus, "running");
    runtime.emit({
      type: "RUN_FINISHED", taskId: firstTaskId, sessionId: "session-ag-ui-success", provider: "codex",
      payload: { type: "RUN_FINISHED", threadId: "thread-test", runId: "run-test", result: "done" },
    });
    assert.equal(runtime.db.getSession("session-ag-ui-success")?.runtimeStatus, "stopped");
    assert.equal(runtime.db.getTask(firstTaskId)?.status, "in_review");

    insertTestSession(secondTaskId, "session-ag-ui-failure");
    runtime.emit({
      type: "RUN_ERROR", taskId: secondTaskId, sessionId: "session-ag-ui-failure", provider: "codex",
      payload: { type: "RUN_ERROR", message: "AG-UI run failed" },
    });
    assert.equal(runtime.db.getSession("session-ag-ui-failure")?.runtimeStatus, "failed");
    assert.equal(runtime.db.getTask(secondTaskId)?.status, "needs_attention");

    const details = await app.inject({ method: "GET", url: `/api/workspaces/${workspace.id}` });
    assert.equal(details.json<{ tasks: unknown[]; projects: unknown[] }>().tasks.length, 2);
    assert.equal(details.json<{ tasks: unknown[]; projects: unknown[] }>().projects.length, 1);
    await app.close();
  });
});
