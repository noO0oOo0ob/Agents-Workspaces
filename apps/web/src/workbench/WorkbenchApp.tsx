import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpAgent, type Message } from "@ag-ui/client";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  FileDiff,
  FolderGit2,
  GitBranch,
  LayoutDashboard,
  ListTodo,
  LoaderCircle,
  MessageSquareText,
  PanelRight,
  Plus,
  RefreshCw,
  Settings2,
  TerminalSquare,
  WandSparkles,
  X,
} from "lucide-react";
import { api, post } from "../api.js";
import "./workbench.css";

type Provider = "codex" | "claude";
type TaskStatus = "todo" | "in_progress" | "needs_attention" | "in_review" | "done" | "cancelled" | "archived";
type InspectorTab = "overview" | "changes" | "activity";

interface Workspace { id: string; name: string; rootPath: string; branchPrefix: string; status: string }
interface ProjectLink { id: string; name: string; remoteUrl: string; worktreePath: string; branch: string; baseBranch: string }
interface Task { id: string; title: string; description: string; status: TaskStatus; updatedAt: string }
interface Session { id: string; provider: Provider; executorType: "native" | "docker"; runtimeStatus: string; summary: string | null; error: string | null }
interface AgentRun { id: string; status: string; startedAt: string; endedAt: string | null; error: string | null }
interface Interaction { id: string; kind: string; title: string; message: string | null; status: string; riskLevel: string; availableDecisions: string[] }
interface EventItem { sequence: number; type: string; occurredAt: string; payload: unknown }
interface TaskDetails { task: Task; sessions: Session[]; runs: AgentRun[]; interactions: Interaction[]; events: EventItem[] }
interface WorkspaceDetails { workspace: Workspace; projects: ProjectLink[]; tasks: TaskDetails[] }
interface Change { repositoryId: string; repositoryName: string; worktreePath: string; status: string; diff: string; diffStat: string; commits: string[] }
interface ThreadHistory { threadId: string; messages: Array<{ id: string; role: "user" | "assistant"; content: string }>; runs: AgentRun[]; sequence: number }
interface Health { status: string; providers: Record<Provider, { installed: boolean; version?: string }>; executors: Record<"native" | "docker", { ready: boolean; message?: string }> }

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 1_500, retry: 1 } } });
const statusLabel: Record<TaskStatus, string> = {
  todo: "Queued", in_progress: "Running", needs_attention: "Needs input", in_review: "Review", done: "Done", cancelled: "Cancelled", archived: "Archived",
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => text(item)).join("");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
  }
  return "";
}

function messageText(message: Message): string {
  if (message.role === "activity") return JSON.stringify(message.content);
  return text(message.content);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || value;
}

function StatusPill({ status }: { status: TaskStatus }) {
  return <span className={`wb-status wb-status-${status}`}><i />{statusLabel[status]}</span>;
}

function useDomainRefresh() {
  const client = useQueryClient();
  useEffect(() => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/api/events/ws?snapshot=0`);
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void client.invalidateQueries({ queryKey: ["workspaces"] });
        void client.invalidateQueries({ queryKey: ["workspace"] });
        void client.invalidateQueries({ queryKey: ["thread"] });
        void client.invalidateQueries({ queryKey: ["changes"] });
      }, 80);
    };
    socket.addEventListener("message", refresh);
    return () => { window.clearTimeout(timer); socket.close(); };
  }, [client]);
}

export function WorkbenchApp() {
  return <QueryClientProvider client={queryClient}><Workbench /></QueryClientProvider>;
}

function Workbench() {
  const client = useQueryClient();
  useDomainRefresh();
  const [workspaceId, setWorkspaceId] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<InspectorTab>("overview");
  const [composerOpen, setComposerOpen] = useState<"task" | "workspace" | "project" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const health = useQuery({ queryKey: ["health"], queryFn: () => api<Health>("/api/health") });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => api<{ items: WorkspaceDetails[] }>("/api/workspaces") });

  useEffect(() => {
    const first = workspaces.data?.items[0]?.workspace.id ?? "";
    setWorkspaceId((current) => current && workspaces.data?.items.some((item) => item.workspace.id === current) ? current : first);
  }, [workspaces.data]);

  const workspace = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<WorkspaceDetails>(`/api/workspaces/${workspaceId}`),
    enabled: Boolean(workspaceId),
  });
  const activeTask = workspace.data?.tasks.find((item) => item.task.id === taskId) ?? null;

  useEffect(() => {
    if (!workspace.data) return;
    setTaskId((current) => current && workspace.data?.tasks.some((item) => item.task.id === current) ? current : workspace.data.tasks[0]?.task.id ?? null);
  }, [workspace.data]);

  const changes = useQuery({
    queryKey: ["changes", taskId],
    queryFn: () => api<{ items: Change[] }>(`/api/tasks/${taskId}/changes`).then((result) => result.items),
    enabled: Boolean(taskId),
  });
  const history = useQuery({
    queryKey: ["thread", taskId],
    queryFn: () => api<ThreadHistory>(`/api/agent/threads/${taskId}`),
    enabled: Boolean(taskId),
  });

  const refresh = useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["workspaces"] }),
      client.invalidateQueries({ queryKey: ["workspace", workspaceId] }),
      taskId ? client.invalidateQueries({ queryKey: ["thread", taskId] }) : Promise.resolve(),
      taskId ? client.invalidateQueries({ queryKey: ["changes", taskId] }) : Promise.resolve(),
    ]);
  }, [client, taskId, workspaceId]);

  return <main className="workbench">
    <header className="wb-topbar">
      <div className="wb-brand"><span className="wb-mark"><WandSparkles size={16} /></span><div><strong>Workspaces</strong><span>local agent workbench</span></div></div>
      <div className="wb-breadcrumb"><span>{workspace.data?.workspace.name ?? "No workspace"}</span>{activeTask && <><ChevronRight size={14} /><strong>{activeTask.task.title}</strong></>}</div>
      <div className="wb-top-actions">
        <span className={`wb-daemon ${health.data?.status === "ok" ? "ready" : ""}`}><i />{health.data?.status === "ok" ? "Daemon ready" : "Connecting"}</span>
        <button className="wb-button ghost" title="Refresh" onClick={() => void refresh()}><RefreshCw size={16} /></button>
        <button className="wb-button primary" title={workspace.data?.projects.length ? "Create a Task" : "Add a Project before creating a Task"} disabled={!workspaceId || !workspace.data?.projects.length} onClick={() => setComposerOpen("task")}><Plus size={16} />New task</button>
      </div>
    </header>
    {error && <div className="wb-error"><span>{error}</span><button onClick={() => setError(null)}><X size={15} /></button></div>}
    <section className="wb-body">
      <aside className="wb-sidebar">
        <div className="wb-sidebar-heading"><span>Workspaces</span><button title="Create workspace" onClick={() => setComposerOpen("workspace")}><Plus size={15} /></button></div>
        <nav>{workspaces.isLoading && <SidebarSkeleton />}{workspaces.data?.items.map((item) => <WorkspaceNavigation
          key={item.workspace.id} item={item} active={item.workspace.id === workspaceId} activeTaskId={taskId}
          onSelect={() => { setWorkspaceId(item.workspace.id); setTaskId(item.tasks[0]?.task.id ?? null); }}
          onTaskSelect={setTaskId}
        />)}</nav>
        {!workspaces.isLoading && !workspaces.data?.items.length && <div className="wb-empty-side"><FolderGit2 size={18} /><p>No workspace yet</p><button onClick={() => setComposerOpen("workspace")}>Create one</button></div>}
        <div className="wb-sidebar-footer"><button><Settings2 size={16} />Settings</button><span>Local only</span></div>
      </aside>
      <section className="wb-content">
        {workspace.isLoading && <LoadingSurface />}
        {!workspace.isLoading && !activeTask && <EmptyTaskState
          workspace={workspace.data?.workspace ?? null}
          projectCount={workspace.data?.projects.length ?? 0}
          onAddProject={() => setComposerOpen("project")}
          onCreate={() => setComposerOpen("task")}
        />}
        {activeTask && <TaskSurface
          key={activeTask.task.id}
          detail={activeTask}
          {...(workspace.data?.workspace ? { workspace: workspace.data.workspace } : {})}
          {...(history.data ? { history: history.data } : {})}
          loadingHistory={history.isLoading}
          onCompleted={() => void refresh()}
        />}
      </section>
      <Inspector
        tab={inspector} setTab={setInspector} task={activeTask} {...(workspace.data?.workspace ? { workspace: workspace.data.workspace } : {})}
        changes={changes.data ?? []} events={activeTask?.events ?? []} onRefresh={() => void refresh()} onError={setError}
      />
    </section>
    <footer className="wb-bottom"><div><TerminalSquare size={15} /><span>Agent transport: AG-UI / SSE</span></div><div><span>{activeTask?.sessions.at(-1)?.provider === "claude" ? "Claude Code" : "Codex"}</span><span className="wb-separator" /> <span>{changes.data?.length ?? 0} repositories inspected</span></div></footer>
    {composerOpen === "task" && workspace.data && <CreateTaskDialog workspace={workspace.data.workspace} onClose={() => setComposerOpen(null)} onCreated={(nextTaskId) => { setComposerOpen(null); setTaskId(nextTaskId); void refresh(); }} onError={setError} />}
    {composerOpen === "project" && workspace.data && <AddProjectDialog workspace={workspace.data.workspace} onClose={() => setComposerOpen(null)} onCreated={() => { setComposerOpen(null); void refresh(); }} onError={setError} />}
    {composerOpen === "workspace" && <CreateWorkspaceDialog onClose={() => setComposerOpen(null)} onCreated={(id) => { setComposerOpen(null); setWorkspaceId(id); void refresh(); }} onError={setError} />}
  </main>;
}

function WorkspaceNavigation({ item, active, activeTaskId, onSelect, onTaskSelect }: { item: WorkspaceDetails; active: boolean; activeTaskId: string | null; onSelect(): void; onTaskSelect(id: string): void }) {
  return <section className={`wb-workspace-nav ${active ? "active" : ""}`}>
    <button className="wb-workspace-row" onClick={onSelect}><FolderGit2 size={16} /><span><strong>{item.workspace.name}</strong><small>{item.projects.length} projects · {item.tasks.length} tasks</small></span><ChevronRight size={15} /></button>
    {active && <div className="wb-task-nav">{item.tasks.map(({ task, interactions }) => <button key={task.id} className={task.id === activeTaskId ? "selected" : ""} onClick={() => onTaskSelect(task.id)}><StatusDot status={task.status} /><span>{task.title}</span>{interactions.some((value) => value.status === "pending") && <em>!</em>}</button>)}</div>}
  </section>;
}

function StatusDot({ status }: { status: TaskStatus }) { return <i className={`wb-dot ${status}`} />; }

function SidebarSkeleton() { return <div className="wb-skeleton-side"><i /><i /><i /></div>; }
function LoadingSurface() { return <div className="wb-loading"><LoaderCircle size={22} /><span>Opening workspace…</span></div>; }

function EmptyTaskState({ workspace, projectCount, onAddProject, onCreate }: { workspace: Workspace | null; projectCount: number; onAddProject(): void; onCreate(): void }) {
  if (!workspace) return <div className="wb-empty-main"><div className="wb-empty-icon"><Bot size={26} /></div><h1>Choose a workspace</h1><p>Your local Workspaces will appear here.</p></div>;
  const hasProjects = projectCount > 0;
  return <div className="wb-empty-main"><div className="wb-empty-icon"><Bot size={26} /></div><h1>{hasProjects ? "Create the first task" : "Add the first project"}</h1><p>{hasProjects ? "A task is a durable Agent thread attached to this Workspace and its project worktrees." : "Connect a remote or local Git repository to create an isolated worktree for this Workspace."}</p><div className="wb-empty-actions">{!hasProjects && <button className="wb-button ghost" onClick={onAddProject}><FolderGit2 size={16} />Add project</button>}<button className="wb-button primary" disabled={!hasProjects} onClick={onCreate}><Plus size={16} />Create task</button></div></div>;
}

function TaskSurface({ detail, workspace, history, loadingHistory, onCompleted }: { detail: TaskDetails; workspace?: Workspace; history?: ThreadHistory; loadingHistory: boolean; onCompleted(): void }) {
  return <section className="wb-task-surface">
      <header className="wb-task-header"><div><div className="wb-kicker"><ListTodo size={14} />Task thread</div><h1>{detail.task.title}</h1><p>{workspace?.name ?? "Workspace"} <span>·</span> {detail.sessions.at(-1)?.provider === "claude" ? "Claude Code" : "Codex"} <span>·</span> {detail.sessions.at(-1)?.executorType ?? "native"}</p></div><div className="wb-task-header-meta"><StatusPill status={detail.task.status} /><span>{detail.runs.length} runs</span></div></header>
      <div className="wb-task-description"><span>Initial brief</span><p>{detail.task.description}</p></div>
      {loadingHistory ? <LoadingSurface /> : <AgentConversation task={detail.task} {...(history ? { history } : {})} onCompleted={onCompleted} />}
    </section>;
}

function AgentConversation({ task, history, onCompleted }: { task: Task; history?: ThreadHistory; onCompleted(): void }) {
  const { agent, messages, isRunning } = useTaskAgent(task.id);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hydrationKey = `${task.id}:${history?.sequence ?? 0}`;
  const hydrated = useRef("");

  useEffect(() => {
    if (!history || isRunning || hydrated.current === hydrationKey) return;
    const savedMessages: Message[] = history.messages.map((message) => ({ id: message.id, role: message.role, content: message.content }));
    agent.setMessages(savedMessages);
    hydrated.current = hydrationKey;
  }, [agent, history, hydrationKey, isRunning]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [isRunning, messages]);

  async function submit() {
    const content = draft.trim();
    if (!content || isRunning) return;
    setError(null);
    setDraft("");
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content });
    try {
      await agent.runAgent();
      onCompleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <section className="wb-conversation">
    <div className="wb-message-scroll" ref={scrollRef}>
      {!messages.length && <div className="wb-conversation-empty"><Bot size={18} /><p>Agent history is ready. Continue this Task whenever you are ready.</p></div>}
      {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
      {isRunning && <div className="wb-running"><LoaderCircle size={15} />Agent is working</div>}
    </div>
    <div className="wb-composer">
      {error && <div className="wb-composer-error">{error}<button onClick={() => setError(null)}><X size={14} /></button></div>}
      <textarea value={draft} placeholder={isRunning ? "Agent is working…" : "Continue this task…"} disabled={isRunning} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(); }} />
      <div><span>⌘ Enter to send</span><button className="wb-button send" disabled={!draft.trim() || isRunning} onClick={() => void submit()}>{isRunning ? <LoaderCircle size={16} /> : <ArrowUp size={16} />}</button></div>
    </div>
  </section>;
}

function useTaskAgent(threadId: string) {
  const agent = useMemo(() => new HttpAgent({ agentId: "workspace-agent", threadId, url: "/api/agent/run" }), [threadId]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  useEffect(() => {
    const sync = () => {
      setMessages([...agent.messages]);
      setIsRunning(agent.isRunning);
    };
    const subscription = agent.subscribe({
      onMessagesChanged: sync,
      onRunInitialized: sync,
      onRunFinalized: sync,
      onRunFailed: sync,
    });
    sync();
    return () => subscription.unsubscribe();
  }, [agent]);
  return { agent, messages, isRunning };
}

function MessageBubble({ message }: { message: Message }) {
  const content = messageText(message);
  if (message.role === "reasoning") return <details className="wb-reasoning"><summary><Activity size={14} />Reasoning</summary><p>{content}</p></details>;
  if (message.role === "tool") return <div className="wb-tool-message"><TerminalSquare size={14} /><span>{content || "Tool completed"}</span></div>;
  if (message.role === "activity") return <div className="wb-tool-message"><Activity size={14} /><span>{content || "Agent activity"}</span></div>;
  if (message.role !== "user" && message.role !== "assistant") return null;
  const toolCalls = message.role === "assistant" && "toolCalls" in message ? message.toolCalls : undefined;
  return <article className={`wb-message ${message.role}`}><div className="wb-message-avatar">{message.role === "user" ? "You" : <Bot size={15} />}</div><div className="wb-message-body"><div className="wb-message-label">{message.role === "user" ? "You" : "Agent"}</div>{content && <p>{content}</p>}{toolCalls?.map((call) => <div className="wb-inline-tool" key={call.id}><TerminalSquare size={13} />{call.function.name}</div>)}</div></article>;
}

function Inspector({ tab, setTab, task, workspace, changes, events, onRefresh, onError }: { tab: InspectorTab; setTab(tab: InspectorTab): void; task: TaskDetails | null; workspace?: Workspace; changes: Change[]; events: EventItem[]; onRefresh(): void; onError(message: string): void }) {
  return <aside className="wb-inspector">
    <header><div><span>Inspector</span><strong>{tab === "overview" ? "Context" : tab === "changes" ? "Changes" : "Activity"}</strong></div><PanelRight size={17} /></header>
    <nav>{(["overview", "changes", "activity"] as InspectorTab[]).map((item) => <button className={item === tab ? "active" : ""} key={item} onClick={() => setTab(item)}>{item === "overview" ? <CircleDot size={15} /> : item === "changes" ? <FileDiff size={15} /> : <Activity size={15} />}{item}</button>)}</nav>
    <div className="wb-inspector-scroll">
      {!task && <div className="wb-inspector-empty">Select a Task to inspect its context.</div>}
      {task && tab === "overview" && <OverviewPanel task={task} {...(workspace ? { workspace } : {})} onRefresh={onRefresh} onError={onError} />}
      {task && tab === "changes" && <ChangesPanel changes={changes} />}
      {task && tab === "activity" && <ActivityPanel events={events} />}
    </div>
  </aside>;
}

function OverviewPanel({ task, workspace, onRefresh, onError }: { task: TaskDetails; workspace?: Workspace; onRefresh(): void; onError(message: string): void }) {
  return <div className="wb-panel-stack">
    <section className="wb-inspector-card"><span>Workspace</span><strong>{workspace?.name}</strong><code>{shortPath(workspace?.rootPath ?? "")}</code><div className="wb-branch"><GitBranch size={14} />{workspace?.branchPrefix}</div></section>
    <section className="wb-inspector-card"><span>Session</span><strong>{task.sessions.at(-1)?.provider === "claude" ? "Claude Code" : "Codex"}</strong><p>{task.sessions.at(-1)?.runtimeStatus ?? "not started"}</p></section>
    <InteractionQueue interactions={task.interactions} onRefresh={onRefresh} onError={onError} />
  </div>;
}

function InteractionQueue({ interactions, onRefresh, onError }: { interactions: Interaction[]; onRefresh(): void; onError(message: string): void }) {
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pending = interactions.filter((item) => item.status === "pending");
  if (!pending.length) return <section className="wb-inspector-card muted"><Check size={16} /><p>No action required</p></section>;
  async function respond(interaction: Interaction, payload: Record<string, unknown>) {
    setBusy(interaction.id);
    try { await post(`/api/interactions/${interaction.id}/respond`, payload); onRefresh(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }
  return <section className="wb-attention"><header><span>Needs attention</span><strong>{pending.length}</strong></header>{pending.map((interaction) => <article key={interaction.id}><small>{interaction.riskLevel} risk · {interaction.kind}</small><h3>{interaction.title}</h3>{interaction.message && <p>{interaction.message}</p>}{(interaction.kind === "question" || interaction.kind === "form") && <textarea value={answer[interaction.id] ?? ""} placeholder="Enter your response…" onChange={(event) => setAnswer((current) => ({ ...current, [interaction.id]: event.target.value }))} />}<div>{interaction.kind === "question" || interaction.kind === "form" ? <button disabled={busy === interaction.id || !(answer[interaction.id] ?? "").trim()} onClick={() => void respond(interaction, interaction.kind === "question" ? { answers: { answer: { answers: [answer[interaction.id]] } } } : { action: "accept", content: { answer: answer[interaction.id] } })}>Submit</button> : (interaction.availableDecisions.length ? interaction.availableDecisions : ["accept", "decline"]).map((decision) => <button key={decision} className={decision.includes("decline") || decision.includes("deny") ? "danger" : ""} disabled={busy === interaction.id} onClick={() => void respond(interaction, { decision })}>{decision}</button>)}</div></article>)}</section>;
}

function ChangesPanel({ changes }: { changes: Change[] }) {
  if (!changes.length) return <div className="wb-inspector-empty">No tracked project changes yet.</div>;
  return <div className="wb-panel-stack">{changes.map((change) => <details className="wb-change" key={change.repositoryId} open><summary><div><strong>{change.repositoryName}</strong><span>{shortPath(change.worktreePath)}</span></div><FileDiff size={15} /></summary><p>{change.diffStat || change.status || "No working-tree changes"}</p>{change.diff && <pre>{change.diff}</pre>}{change.commits.length > 0 && <ul>{change.commits.map((commit) => <li key={commit}>{commit}</li>)}</ul>}</details>)}</div>;
}

function ActivityPanel({ events }: { events: EventItem[] }) {
  if (!events.length) return <div className="wb-inspector-empty">Activity will appear as the Agent works.</div>;
  return <ol className="wb-activity-list">{[...events].reverse().slice(0, 60).map((event) => <li key={event.sequence}><span>{formatTime(event.occurredAt)}</span><strong>{event.type.replaceAll("_", " ").toLowerCase()}</strong></li>)}</ol>;
}

function Dialog({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: React.ReactNode; onClose(): void }) {
  return <div className="wb-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="wb-dialog"><header><div><span>Workspace manager</span><h2>{title}</h2><p>{subtitle}</p></div><button onClick={onClose}><X size={17} /></button></header>{children}</section></div>;
}

function CreateTaskDialog({ workspace, onClose, onCreated, onError }: { workspace: Workspace; onClose(): void; onCreated(id: string): void; onError(message: string): void }) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<Provider>("codex");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !prompt.trim()) return;
    setBusy(true);
    try { const result = await post<{ task: Task }>(`/api/workspaces/${workspace.id}/tasks`, { title, prompt, provider, executorType: "native", startImmediately: true }); onCreated(result.task.id); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog title="New task" subtitle={`Creates a durable Agent thread in ${workspace.name}.`} onClose={onClose}><form onSubmit={submit}><label>Task title<input value={title} autoFocus onChange={(event) => setTitle(event.target.value)} placeholder="Implement the new onboarding flow" /></label><label>Initial brief<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Explain the goal, constraints, and expected outcome…" /></label><label>Agent provider<select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label><footer><button type="button" className="wb-button ghost" onClick={onClose}>Cancel</button><button className="wb-button primary" disabled={busy || !title.trim() || !prompt.trim()}>{busy ? "Starting…" : "Create & run"}</button></footer></form></Dialog>;
}

function AddProjectDialog({ workspace, onClose, onCreated, onError }: { workspace: Workspace; onClose(): void; onCreated(): void; onError(message: string): void }) {
  const [sourceType, setSourceType] = useState<"remote" | "local">("remote");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!source.trim()) return;
    setBusy(true);
    try {
      await post(`/api/workspaces/${workspace.id}/projects`, sourceType === "remote" ? { sourceType, remoteUrl: source.trim() } : { sourceType, localPath: source.trim() });
      onCreated();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog title="Add project" subtitle="A Project is cloned into this Workspace as an isolated Git worktree." onClose={onClose}><form onSubmit={submit}><label>Source type<select value={sourceType} onChange={(event) => setSourceType(event.target.value as "remote" | "local")}><option value="remote">Remote Git URL</option><option value="local">Local Git repository</option></select></label><label>{sourceType === "remote" ? "Remote URL" : "Local repository path"}<input value={source} autoFocus onChange={(event) => setSource(event.target.value)} placeholder={sourceType === "remote" ? "git@github.com:org/repository.git" : "/Users/you/source-repository"} /></label><footer><button type="button" className="wb-button ghost" onClick={onClose}>Cancel</button><button className="wb-button primary" disabled={busy || !source.trim()}>{busy ? "Preparing worktree…" : "Add project"}</button></footer></form></Dialog>;
}

function CreateWorkspaceDialog({ onClose, onCreated, onError }: { onClose(): void; onCreated(id: string): void; onError(message: string): void }) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try { const result = await post<Workspace>("/api/workspaces", { name, ...(rootPath.trim() ? { rootPath } : {}) }); onCreated(result.id); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog title="Create workspace" subtitle="A Workspace owns the root directory and project worktrees." onClose={onClose}><form onSubmit={submit}><label>Workspace name<input value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="payments-platform" /></label><label>Root path <small>optional</small><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="~/agents-workspaces/payments-platform" /></label><footer><button type="button" className="wb-button ghost" onClick={onClose}>Cancel</button><button className="wb-button primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create workspace"}</button></footer></form></Dialog>;
}
