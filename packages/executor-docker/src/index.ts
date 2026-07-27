import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Executor, ProcessHandle, SpawnInput } from "@agents-workspaces/executor-core";
import { NativeExecutor } from "@agents-workspaces/executor-native";

const execFileAsync = promisify(execFile);

export class DockerExecutor implements Executor {
  readonly type = "docker" as const;
  readonly #native = new NativeExecutor();

  async checkHealth(): Promise<{ ready: boolean; message?: string }> {
    try {
      const { stdout } = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
      return { ready: true, message: `Docker ${stdout.trim()}` };
    } catch (error) {
      return { ready: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async checkImage(image: string, provider: "codex" | "claude"): Promise<{ ready: boolean; message?: string }> {
    try {
      await execFileAsync("docker", ["image", "inspect", image], { encoding: "utf8" });
      const { stdout } = await execFileAsync("docker", ["run", "--rm", image, provider, "--version"], { encoding: "utf8" });
      return { ready: true, message: stdout.trim() };
    } catch (error) {
      return { ready: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async spawn(input: SpawnInput): Promise<ProcessHandle> {
    const image = input.image ?? "agents-workspaces-runner:local";
    const containerName = `agents-workspaces-${input.sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
    const credentialMount = input.provider === "codex"
      ? ["-v", "agents-workspaces-codex:/home/agent/.codex"]
      : ["-v", "agents-workspaces-claude:/home/agent/.claude"];
    const environmentArgs = Object.entries(input.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    return this.#native.spawn({
      ...input,
      command: "docker",
      cwd: input.cwd,
      args: [
        "run", "--rm", "-i", "--init",
        "--name", containerName,
        "--label", `agents-workspaces.session=${input.sessionId}`,
        "--workdir", "/workspace",
        "--security-opt", "no-new-privileges:true",
        "-v", `${input.cwd}:/workspace`,
        ...credentialMount,
        ...environmentArgs,
        image,
        input.command,
        ...input.args,
      ],
    });
  }

  get(processId: string): ProcessHandle | undefined { return this.#native.get(processId); }
  async terminate(processId: string): Promise<void> { await this.#native.terminate(processId); }
}

export const dockerExecutorDefaults = {
  type: "docker", workspaceMount: "/workspace", privileged: false,
  mountDockerSocket: false, runAsRoot: false,
} as const;
