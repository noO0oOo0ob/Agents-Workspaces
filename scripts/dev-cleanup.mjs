import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pidFile = resolve(workspaceRoot, "pids/dev.json");

if (!existsSync(pidFile)) {
  console.log("[dev] 没有找到受管开发进程记录。");
  process.exit(0);
}

const state = JSON.parse(readFileSync(pidFile, "utf8"));
const managed = [];
for (const child of Array.isArray(state.children) ? state.children : []) {
  if (!Number.isInteger(child.pid)) continue;
  managed.push(child);
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    else process.kill(-child.pid, "SIGTERM");
    console.log(`[dev] 已停止 ${String(child.name)} 进程组 ${child.pid}。`);
  } catch (error) {
    if (error?.code !== "ESRCH") console.warn(`[dev] 无法停止进程组 ${child.pid}: ${error.message}`);
  }
}

await new Promise((resolve) => setTimeout(resolve, 1_000));
for (const child of managed) {
  if (process.platform === "win32") continue;
  try {
    process.kill(-child.pid, 0);
    process.kill(-child.pid, "SIGKILL");
    console.log(`[dev] 已强制停止未及时退出的 ${String(child.name)} 进程组 ${child.pid}。`);
  } catch (error) {
    if (error?.code !== "ESRCH") console.warn(`[dev] 无法检查进程组 ${child.pid}: ${error.message}`);
  }
}
rmSync(pidFile, { force: true });
