import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createWorkspace, inspectChanges } from "./index.js";

describe("Workspace Manager", () => {
  it("creates an isolated Git worktree", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-workspaces-git-"));
    const repositoryPath = join(directory, "repository");
    const workspaceRoot = join(directory, "workspaces");
    mkdirSync(repositoryPath);
    mkdirSync(workspaceRoot);
    execFileSync("git", ["init", "-b", "main"], { cwd: repositoryPath });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repositoryPath });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repositoryPath });
    writeFileSync(join(repositoryPath, "README.md"), "# fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repositoryPath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repositoryPath });

    const result = await createWorkspace({
      taskId: "TASK-1", rootPath: workspaceRoot,
      repositories: [{
        repositoryId: "repo-1", repositoryName: "repository", repositoryPath,
        directoryName: "repository", baseBranch: "main", taskBranch: "agent/TASK-1",
      }],
    });
    assert.equal(result.worktrees.length, 1);
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: result.worktrees[0]?.worktreePath, encoding: "utf8" }).trim(), "agent/TASK-1");
    const changes = await inspectChanges([{ repositoryId: "repo-1", repositoryName: "repository", worktreePath: result.worktrees[0]?.worktreePath ?? "", baseBranch: "main" }]);
    assert.equal(changes[0]?.diff, "");
  });
});

