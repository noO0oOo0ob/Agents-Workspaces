import type { AgentProvider, ExecutorType } from "@agents-workspaces/core";

export interface SpawnInput {
  sessionId: string;
  provider: AgentProvider;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  image?: string;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessHandle {
  id: string;
  pid: number | undefined;
  write(data: string | Uint8Array): boolean;
  interrupt(): void;
  terminate(): void;
  onOutput(listener: (stream: "stdout" | "stderr", data: string) => void): () => void;
  onExit(listener: (exit: ProcessExit) => void): () => void;
}

export interface Executor {
  readonly type: ExecutorType;
  checkHealth(): Promise<{ ready: boolean; message?: string }>;
  spawn(input: SpawnInput): Promise<ProcessHandle>;
  get(processId: string): ProcessHandle | undefined;
  terminate(processId: string): Promise<void>;
}
