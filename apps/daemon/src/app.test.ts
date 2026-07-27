import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createApp } from "./app.js";
import { AgentBoardRuntime } from "./runtime.js";

describe("Daemon API", () => {
  it("creates a clean Workspace, mounts Projects, and creates Agent Tasks", async () => {
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

    const insertTestSession = (taskId: string, id: string) => {
      const at = new Date().toISOString();
      runtime.db.markTaskStarted(taskId, at);
      runtime.db.insertSession({
        id, taskId, provider: "codex", executorType: "native", executionProfileId: null,
        providerSessionId: "thread-test", providerTurnId: null, runtimeStatus: "starting",
        prompt: "Test AG-UI state", summary: null, error: null, createdAt: at, updatedAt: at, endedAt: null,
      });
    };
    insertTestSession(firstTaskId, "session-ag-ui-success");
    runtime.emit({ type: "RUN_STARTED", taskId: firstTaskId, sessionId: "session-ag-ui-success", provider: "codex", payload: { type: "RUN_STARTED", threadId: firstTaskId, runId: "run-test" } });
    assert.equal(runtime.db.getSession("session-ag-ui-success")?.runtimeStatus, "running");
    runtime.emit({ type: "RUN_FINISHED", taskId: firstTaskId, sessionId: "session-ag-ui-success", provider: "codex", payload: { type: "RUN_FINISHED", threadId: firstTaskId, runId: "run-test", result: "done" } });
    assert.equal(runtime.db.getSession("session-ag-ui-success")?.runtimeStatus, "stopped");
    assert.equal(runtime.db.getTask(firstTaskId)?.status, "in_review");

    insertTestSession(secondTaskId, "session-ag-ui-failure");
    runtime.emit({ type: "RUN_ERROR", taskId: secondTaskId, sessionId: "session-ag-ui-failure", provider: "codex", payload: { type: "RUN_ERROR", message: "AG-UI run failed" } });
    assert.equal(runtime.db.getSession("session-ag-ui-failure")?.runtimeStatus, "failed");
    assert.equal(runtime.db.getTask(secondTaskId)?.status, "needs_attention");

    const details = await app.inject({ method: "GET", url: `/api/workspaces/${workspace.id}` });
    assert.equal(details.json<{ tasks: unknown[]; projects: unknown[] }>().tasks.length, 2);
    assert.equal(details.json<{ tasks: unknown[]; projects: unknown[] }>().projects.length, 1);

    const archive = await app.inject({ method: "POST", url: `/api/tasks/${firstTaskId}/archive`, payload: {} });
    assert.equal(archive.statusCode, 200, archive.body);
    const afterArchive = await app.inject({ method: "GET", url: `/api/workspaces/${workspace.id}` });
    assert.equal(afterArchive.json<{ tasks: unknown[] }>().tasks.length, 1);

    const deletion = await app.inject({ method: "DELETE", url: `/api/tasks/${secondTaskId}` });
    assert.equal(deletion.statusCode, 200, deletion.body);
    assert.equal(deletion.json<{ deleted: boolean }>().deleted, true);
    assert.equal(runtime.db.getTask(secondTaskId), null);
    assert.equal(existsSync(localWorktree), true);
    await app.close();
  });

  it("protects Claude hooks with the daemon token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-hook-api-"));
    const runtime = new AgentBoardRuntime({ host: "127.0.0.1", listenHost: "127.0.0.1", port: 4310, dataDirectory: join(directory, "data"), workspaceRoot: join(directory, "workspaces"), obsidianVault: null, publicDirectory: null, hookToken: "test-hook-token" });
    const app = await createApp(runtime);
    const response = await app.inject({ method: "POST", url: "/api/hooks/claude?sessionId=missing", payload: {} });
    assert.equal(response.statusCode, 401);
    await app.close();
  });
});
