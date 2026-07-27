#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const command = process.argv[2] ?? "help";

function doctor(): void {
  const checks = ["git", "docker", "codex", "claude"].map((executable) => {
    const location = spawnSync("which", [executable], { encoding: "utf8" });
    if (location.status !== 0) return { executable, installed: false, version: "not found" };
    const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 8_000 });
    return {
      executable,
      installed: true,
      version: (version.stdout || version.stderr).trim().split("\n")[0],
    };
  });
  console.table(checks);
  process.exitCode = checks.some((check) => !check.installed) ? 1 : 0;
}

function start(): void {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const builtDaemon = resolve(currentDirectory, "daemon.js");
  const sourceDaemon = resolve(currentDirectory, "../../daemon/src/index.ts");
  const child = existsSync(builtDaemon)
    ? spawn(process.execPath, [builtDaemon], { stdio: "inherit", env: process.env })
    : spawn(process.execPath, ["--import", "tsx", sourceDaemon], { stdio: "inherit", env: process.env, cwd: process.cwd() });
  if (!process.argv.includes("--no-open") && process.platform === "darwin") {
    const host = process.env.AGENTS_WORKSPACES_HOST ?? "127.0.0.1";
    const port = process.env.AGENTS_WORKSPACES_PORT ?? "4310";
    setTimeout(() => spawn("open", [`http://${host}:${port}`], { stdio: "ignore" }), 800);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}

function init(): void {
  const dataDirectory = resolve(process.env.AGENTS_WORKSPACES_DATA_DIR ?? ".data");
  const workspaceRoot = resolve(process.env.AGENTS_WORKSPACES_WORKSPACE_ROOT ?? "agents-workspaces");
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  console.log(`Initialized:\n  data: ${dataDirectory}\n  workspaces: ${workspaceRoot}`);
}

function login(): void {
  const provider = process.argv[3];
  if (provider !== "codex" && provider !== "claude") {
    console.error("Usage: agents-workspaces login <codex|claude> [image]");
    process.exitCode = 1;
    return;
  }
  const image = process.argv[4] ?? "agents-workspaces-runner:local";
  const volume = provider === "codex" ? "agents-workspaces-codex:/home/agent/.codex" : "agents-workspaces-claude:/home/agent/.claude";
  const providerArgs = provider === "codex" ? ["codex", "login"] : ["claude", "auth", "login"];
  const result = spawnSync("docker", ["run", "--rm", "-it", "-v", volume, image, ...providerArgs], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

if (command === "doctor") doctor();
else if (command === "start") start();
else if (command === "init") init();
else if (command === "login") login();
else {
  console.log(`Agents-Workspaces CLI

Usage:
  agents-workspaces init     Create local data directories
  agents-workspaces doctor   Check Git, Docker, Codex and Claude Code
  agents-workspaces login    Log a Provider into its persistent Docker volume
  agents-workspaces start    Start the local control plane and open the Web UI

Development:
  pnpm dev                   Start daemon and web UI
`);
}
