import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "..");
const pidDirectory = resolve(workspaceRoot, "pids");
const pidFile = resolve(pidDirectory, "dev.json");
const children = new Map();

let shuttingDown = false;
let requestedExitCode = 0;
let forceTimer;

const colors = {
  daemon: "\u001b[36m",
  web: "\u001b[35m",
};
const reset = "\u001b[0m";

function prefixOutput(name, stream) {
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    process.stdout.write(`${colors[name]}[${name}]${reset} ${line}\n`);
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processGroupExists(pid) {
  if (process.platform === "win32") return processExists(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function removePidFile() {
  try {
    rmSync(pidFile, { force: true });
  } catch {
    // The process groups are still terminated even if local metadata cleanup fails.
  }
}

function writePidFile() {
  mkdirSync(pidDirectory, { recursive: true });
  writeFileSync(pidFile, JSON.stringify({
    managerPid: process.pid,
    startedAt: new Date().toISOString(),
    children: [...children.entries()].map(([name, child]) => ({ name, pid: child.pid })),
  }, null, 2));
}

function warnAboutPreviousRun() {
  if (!existsSync(pidFile)) return;
  try {
    const previous = JSON.parse(readFileSync(pidFile, "utf8"));
    const live = Array.isArray(previous.children)
      ? previous.children.filter((child) => Number.isInteger(child.pid) && processExists(child.pid))
      : [];
    if (live.length) {
      console.warn(
        `[dev] 检测到上次异常退出后仍存在的受管进程：${live.map((child) => `${child.name}:${child.pid}`).join(", ")}。\n` +
        "[dev] 为避免误杀复用 PID 的其他程序，本次不会自动终止它们；请确认后执行 pnpm dev:cleanup。",
      );
    } else {
      removePidFile();
    }
  } catch {
    removePidFile();
  }
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") console.error(`[dev] 无法向进程组 ${child.pid} 发送 ${signal}:`, error);
  }
}

function finishIfStopped() {
  if (!shuttingDown || [...children.values()].some((child) => child.pid && processGroupExists(child.pid))) return;
  if (forceTimer) clearTimeout(forceTimer);
  removePidFile();
  process.exitCode = requestedExitCode;
}

function shutdown(signal = "SIGTERM", exitCode = 0) {
  if (shuttingDown) {
    for (const child of children.values()) signalGroup(child, "SIGKILL");
    return;
  }
  shuttingDown = true;
  requestedExitCode = exitCode;
  console.log(`\n[dev] 正在停止所有开发进程（${signal}）...`);
  for (const child of children.values()) signalGroup(child, signal);
  forceTimer = setTimeout(() => {
    const live = [...children.values()].filter((child) => child.pid && processGroupExists(child.pid));
    if (live.length) {
      console.warn("[dev] 部分进程未按时退出，正在强制释放端口...");
      for (const child of live) signalGroup(child, "SIGKILL");
    }
    setTimeout(finishIfStopped, 100);
  }, 3_000);
  finishIfStopped();
}

function start(name, script) {
  const child = spawn("pnpm", [script], {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(name, child);
  prefixOutput(name, child.stdout);
  prefixOutput(name, child.stderr);
  child.on("error", (error) => {
    console.error(`[dev] ${name} 启动失败:`, error);
    shutdown("SIGTERM", 1);
  });
  child.on("close", (code, signal) => {
    if (!shuttingDown) {
      const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      console.error(`[dev] ${name} 已退出（${reason}），正在停止其他开发进程。`);
      shutdown("SIGTERM", code ?? 1);
    }
    finishIfStopped();
  });
}

warnAboutPreviousRun();
start("daemon", "dev:daemon");
start("web", "dev:web");
writePidFile();

process.once("SIGINT", () => shutdown("SIGINT", 0));
process.once("SIGTERM", () => shutdown("SIGTERM", 0));
process.once("SIGHUP", () => shutdown("SIGHUP", 0));
process.on("exit", () => {
  for (const child of children.values()) signalGroup(child, "SIGKILL");
  removePidFile();
});
