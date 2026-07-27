import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import type { Executor, ProcessExit, ProcessHandle, SpawnInput } from "@agents-workspaces/executor-core";

const execFileAsync = promisify(execFile);

class ChildProcessHandle implements ProcessHandle {
  readonly id: string;
  readonly pid: number | undefined;
  readonly #events = new EventEmitter();
  readonly #child: ChildProcessWithoutNullStreams;

  constructor(id: string, child: ChildProcessWithoutNullStreams) {
    this.id = id;
    this.pid = child.pid;
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.#events.emit("output", "stdout", data));
    child.stderr.on("data", (data: string) => this.#events.emit("output", "stderr", data));
    child.on("exit", (code, signal) => this.#events.emit("exit", { code, signal } satisfies ProcessExit));
    child.on("error", (error) => this.#events.emit("output", "stderr", error.message));
  }

  write(data: string | Uint8Array): boolean { return this.#child.stdin.write(data); }
  interrupt(): void { this.#child.kill("SIGINT"); }
  terminate(): void { this.#child.kill("SIGTERM"); }
  onOutput(listener: (stream: "stdout" | "stderr", data: string) => void): () => void {
    this.#events.on("output", listener);
    return () => this.#events.off("output", listener);
  }
  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.#events.on("exit", listener);
    return () => this.#events.off("exit", listener);
  }
}

export class NativeExecutor implements Executor {
  readonly type = "native" as const;
  readonly #processes = new Map<string, ProcessHandle>();

  async checkHealth(): Promise<{ ready: boolean; message?: string }> {
    try {
      const { stdout } = await execFileAsync("git", ["--version"], { encoding: "utf8" });
      return { ready: true, message: stdout.trim() };
    } catch (error) {
      return { ready: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async spawn(input: SpawnInput): Promise<ProcessHandle> {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const handle = new ChildProcessHandle(input.sessionId, child);
    this.#processes.set(handle.id, handle);
    handle.onExit(() => this.#processes.delete(handle.id));
    return handle;
  }

  get(processId: string): ProcessHandle | undefined { return this.#processes.get(processId); }
  async terminate(processId: string): Promise<void> { this.#processes.get(processId)?.terminate(); }
}

export const nativeExecutorDefaults = { type: "native", inheritShellEnvironment: false, gracefulShutdownMs: 5_000 } as const;

