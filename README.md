# Agents-Workspaces

面向 Codex 与 Claude Code 的本地多 Agent 开发控制台。

Agents-Workspaces 将一个跨多个 Git 仓库的需求组织成隔离 Workspace，在本机或本机 Docker 中运行 Agent，并通过统一看板管理运行状态、用户审批、结构化问答和代码审阅。

## 当前状态

P0 已实现，当前仓库包含：

- `apps/cli`：本地命令行入口；
- `apps/daemon`：本地 Gateway/API；
- `apps/web`：React 看板；
- `packages/core`：领域模型和任务状态机；
- `packages/agent-*`：Codex、Claude Code 适配器边界；
- `packages/executor-*`：Native、Docker 执行器边界；
- Workspace、Interaction、Event、Knowledge 等完整 P0 模块；
- 六列实时看板、应用内创建表单、审批/问答、代码 Diff 与 Review；
- Native 与本机 Docker 执行、独立凭证卷和安全的 Claude HTTP Hook 回调。

## 环境要求

- macOS
- Node.js 22 或更高版本
- pnpm 10 或更高版本
- Git
- Docker Desktop（使用 Docker Executor 时）
- Codex CLI（使用 Codex 时）
- Claude Code CLI（使用 Claude Code 时）

## 开始开发

```bash
pnpm install
pnpm build
pnpm start
```

首次使用 Docker Executor 前构建本地 Runner 镜像：

```bash
pnpm docker:build
```

然后分别在持久凭证卷中登录（每个 Provider 只需执行一次）：

```bash
pnpm login:codex
pnpm login:claude
```

开发时也可以分别启动：

```bash
pnpm dev:daemon
pnpm dev:web
```

服务默认对用户界面只允许本机访问；进程监听所有本机接口，是为了让 Docker Desktop 中的 Claude Code 能通过 `host.docker.internal` 回调。非 Hook 请求会按来源地址拒绝，Hook 使用每次启动生成的 Bearer Token。

常用检查：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 仓库结构

```text
apps/
├── cli/
├── daemon/
└── web/
packages/
├── core/
├── database/
├── event-bus/
├── workspace-manager/
├── executor-core/
├── executor-native/
├── executor-docker/
├── agent-core/
├── agent-codex/
├── agent-claude/
├── interaction-manager/
└── knowledge-compiler/
```

## P0 边界

- 只支持 Codex 与 Claude Code；
- 只支持 macOS 本机控制平面；
- 执行环境支持 Native 和本机 Docker；
- 使用 Git Worktree 形成多仓库隔离 Workspace；
- 使用本地 Obsidian Vault 维护知识；
- 暂不支持云 Runner、多用户和跨设备同步。

## License

[MIT](./LICENSE)
