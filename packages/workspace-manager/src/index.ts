import { execFile } from "node:child_process";
import { mkdir, realpath, rmdir, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { RepositoryChanges } from "@agents-workspaces/core";

const execFileAsync = promisify(execFile);

export interface WorkspaceRepositoryInput {
  repositoryId: string;
  repositoryName: string;
  repositoryPath: string;
  directoryName: string;
  baseBranch: string;
  taskBranch: string;
}

export interface CreateWorkspaceInput {
  taskId: string;
  rootPath: string;
  repositories: WorkspaceRepositoryInput[];
  fetch?: boolean;
}

export interface CreatedWorktree extends WorkspaceRepositoryInput {
  worktreePath: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return stdout.trim();
}

export function resolveWorkspacePath(rootPath: string, taskId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) throw new Error("Task ID contains unsafe path characters");
  const root = resolve(rootPath);
  const workspace = resolve(root, taskId);
  if (!workspace.startsWith(`${root}${sep}`)) throw new Error("Workspace path escapes configured root");
  return workspace;
}

export function safeDirectoryName(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") throw new Error(`Unsafe repository directory: ${value}`);
  return normalized;
}

export async function validateGitRepository(repositoryPath: string): Promise<string> {
  const resolved = await realpath(repositoryPath);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`${repositoryPath} is not a directory`);
  const top = await git(resolved, ["rev-parse", "--show-toplevel"]);
  if (resolve(top) !== resolve(resolved)) throw new Error(`${repositoryPath} must point to the repository root`);
  return resolved;
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<{ workspacePath: string; worktrees: CreatedWorktree[] }> {
  if (input.repositories.length === 0) throw new Error("At least one repository is required");
  await mkdir(resolve(input.rootPath), { recursive: true });
  const workspacePath = resolveWorkspacePath(input.rootPath, input.taskId);
  await mkdir(workspacePath, { recursive: false });
  const created: CreatedWorktree[] = [];

  try {
    for (const item of input.repositories) {
      const repositoryPath = await validateGitRepository(item.repositoryPath);
      if (input.fetch) await git(repositoryPath, ["fetch", "--prune"]);
      await git(repositoryPath, ["rev-parse", "--verify", item.baseBranch]);
      const directoryName = safeDirectoryName(item.directoryName || item.repositoryName || basename(repositoryPath));
      const worktreePath = join(workspacePath, directoryName);
      const branchExists = await git(repositoryPath, ["branch", "--list", item.taskBranch]);
      const args = branchExists
        ? ["worktree", "add", worktreePath, item.taskBranch]
        : ["worktree", "add", "-b", item.taskBranch, worktreePath, item.baseBranch];
      await git(repositoryPath, args);
      created.push({ ...item, repositoryPath, directoryName, worktreePath });
    }
    return { workspacePath, worktrees: created };
  } catch (error) {
    for (const item of [...created].reverse()) {
      try { await git(item.repositoryPath, ["worktree", "remove", item.worktreePath]); } catch { /* preserve original error */ }
    }
    try { await rmdir(workspacePath); } catch { /* a non-empty directory is useful evidence for manual recovery */ }
    throw error;
  }
}

export async function inspectChanges(worktrees: Array<{ repositoryId: string; repositoryName: string; worktreePath: string; baseBranch: string }>): Promise<RepositoryChanges[]> {
  return Promise.all(worktrees.map(async (item) => {
    const [status, diff, diffStat, commitsText] = await Promise.all([
      git(item.worktreePath, ["status", "--short"]),
      git(item.worktreePath, ["diff", "--no-ext-diff", `${item.baseBranch}...HEAD`]),
      git(item.worktreePath, ["diff", "--stat", `${item.baseBranch}...HEAD`]),
      git(item.worktreePath, ["log", "--format=%h %s", `${item.baseBranch}..HEAD`]),
    ]);
    return {
      repositoryId: item.repositoryId,
      repositoryName: item.repositoryName,
      worktreePath: item.worktreePath,
      status,
      diff,
      diffStat,
      commits: commitsText ? commitsText.split("\n") : [],
    };
  }));
}

export async function removeWorkspaceWorktrees(worktrees: Array<{ repositoryPath: string; worktreePath: string }>, force = false): Promise<void> {
  for (const item of [...worktrees].reverse()) {
    const status = await git(item.worktreePath, ["status", "--porcelain"]);
    if (status && !force) throw new Error(`Worktree has uncommitted changes: ${item.worktreePath}`);
    await git(item.repositoryPath, ["worktree", "remove", ...(force ? ["--force"] : []), item.worktreePath]);
  }
}
