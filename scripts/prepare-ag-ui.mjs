import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "..");
const agUiRoot = resolve(
  process.env.AG_UI_REPO_PATH ?? resolve(workspaceRoot, "../ag-ui"),
);

const packages = [
  {
    name: "@ag-ui/core",
    directory: "sdks/typescript/packages/core",
  },
  {
    name: "@agents-workspaces/ag-ui-codex-app-server",
    directory: "integrations/codex-app-server/typescript",
  },
  {
    name: "@agents-workspaces/ag-ui-claude-code",
    directory: "integrations/claude-code/typescript",
  },
];

function fail(message) {
  console.error(`[ag-ui] ${message}`);
  process.exit(1);
}

function runPnpm(args, cwd) {
  const result = spawnSync("pnpm", args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    fail(`无法执行 pnpm：${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readPackageName(directory) {
  const manifestPath = resolve(directory, "package.json");
  if (!existsSync(manifestPath)) {
    fail(`缺少 package.json：${manifestPath}`);
  }

  return JSON.parse(readFileSync(manifestPath, "utf8")).name;
}

function linkPackage(packageInfo) {
  const source = resolve(agUiRoot, packageInfo.directory);
  const [scope, packageName] = packageInfo.name.split("/");
  const linkDirectory = resolve(workspaceRoot, "node_modules", scope);
  const destination = resolve(linkDirectory, packageName);

  mkdirSync(linkDirectory, { recursive: true });

  try {
    const stat = lstatSync(destination);
    if (!stat.isSymbolicLink()) {
      fail(
        `无法关联 ${packageInfo.name}：目标已存在且不是符号链接（${destination}）`,
      );
    }

    const currentTarget = resolve(linkDirectory, readlinkSync(destination));
    if (currentTarget === source) {
      return;
    }

    unlinkSync(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  symlinkSync(source, destination, "dir");
}

if (!existsSync(resolve(agUiRoot, "pnpm-workspace.yaml"))) {
  fail(
    `没有找到 AG-UI 仓库：${agUiRoot}\n` +
      "请把仓库放在主工程同级的 ag-ui 目录，或设置 AG_UI_REPO_PATH。",
  );
}

for (const packageInfo of packages) {
  const packageDirectory = resolve(agUiRoot, packageInfo.directory);
  const actualName = readPackageName(packageDirectory);
  if (actualName !== packageInfo.name) {
    fail(
      `包名不匹配：期望 ${packageInfo.name}，实际为 ${actualName}（${packageDirectory}）`,
    );
  }
}

if (!existsSync(resolve(agUiRoot, "node_modules/.pnpm"))) {
  console.log("[ag-ui] 首次使用，正在安装 AG-UI workspace 依赖...");
  runPnpm(["install", "--frozen-lockfile"], agUiRoot);
}

console.log(`[ag-ui] 构建本地 SDK：${agUiRoot}`);
for (const packageInfo of packages) {
  runPnpm(["--filter", packageInfo.name, "build"], agUiRoot);
}

console.log("[ag-ui] 关联本地 SDK 到 Agents-Workspaces...");
for (const packageInfo of packages) {
  linkPackage(packageInfo);
}

console.log("[ag-ui] 本地 SDK 已构建并关联完成。");
