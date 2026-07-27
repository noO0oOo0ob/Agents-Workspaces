# Agents-Workspaces

面向 Codex 与 Claude Code 的本地多 Agent 开发控制台。

Agents-Workspaces 将一个跨多个 Git 仓库的需求组织成隔离 Workspace，在本机或本机 Docker 中运行 Agent，并通过统一看板管理运行状态、用户审批、结构化问答和代码审阅。

## 当前状态

P0 已实现，当前仓库包含：

- `apps/cli`：本地命令行入口；
- `apps/daemon`：本地 Gateway/API；
- `apps/web`：React Workbench；
- `packages/core`：领域模型和任务状态机；
- `packages/agent-*`：Codex、Claude Code 适配器边界；
- `packages/executor-*`：Native、Docker 执行器边界；
- Workspace、Interaction、Event、Knowledge 等完整 P0 模块；
- Workspace 导航、Task Agent 线程、审批/问答、代码 Diff 与 Review；
- Native 与本机 Docker 执行、独立凭证卷和安全的 Claude HTTP Hook 回调。

## Workspace、Project 与 Task 流程

1. 先创建 Workspace，指定名称、目录和可选的共享分支名；
2. 向 Workspace 添加一个或多个 Project：
   - `Clone URL`：克隆远端仓库并登记为 Project；
   - `Local repository`：读取本地仓库的 `origin`，重新克隆后登记；
3. 系统从全局受管 Clone 创建 Worktree，并放入 Workspace；
4. 在 Workspace 中创建多个 Task，每个 Task 对应一个 Codex 或 Claude Code CLI 进程；
5. CLI 始终以 Workspace 根目录作为 `cwd`，Chat、审批、问答、文件变化和事件统一进入看板。

本地来源仓库不会被 Agent 直接修改。同一 Workspace 中的多个 Task 共享相同 Worktree，因此适合按 Project 或目录划分并行职责。

Web UI 是以 Task 为中心的 Workbench：左侧切换 Workspace 和 Task，中间呈现 AG-UI Agent 线程，右侧提供上下文、代码变更和活动检查器。Provider 只在创建 Task 和 Task 详情中显示，鉴权在全局设置中配置一次。

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
pnpm dev
```

`pnpm dev` 会先构建并关联主工程同级 `../ag-ui` 仓库中的 AG-UI Core、Codex App Server Adapter 和 Claude Code Adapter，然后同时启动 daemon 与 web。AG-UI 仓库位于其他位置时，可通过 `AG_UI_REPO_PATH` 指定：

```bash
AG_UI_REPO_PATH=/absolute/path/to/ag-ui pnpm dev
```

如需跳过完整启动、只刷新 AG-UI 本地 SDK 链接，可以执行：

```bash
pnpm ag-ui:prepare
```

Agent 会话使用 AG-UI 标准事件持久化和实时传输，包括 `RUN_*`、`TEXT_MESSAGE_*`、`TOOL_CALL_*` 与 `REASONING_*`。Task 是持久化 Thread，每次用户交互都记录为独立 Run；本项目不读取或迁移旧格式的会话历史。

开发进程由 `scripts/dev.mjs` 统一管理。按一次 `Ctrl+C` 会向 daemon、web 及其 watcher 的完整进程组转发退出信号，等待 3 秒后仍未退出则强制清理。Web 端口被占用时会直接报错，不会自动切换到 4312。仅在进程被强制关闭或机器断电、且留下受管 PID 记录时，可以执行：

```bash
pnpm dev:cleanup
```

也可以分别启动 daemon 和 web（这种方式不会自动重新构建 AG-UI）：

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
