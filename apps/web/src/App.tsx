import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "./api.js";

type Status = "todo" | "in_progress" | "needs_attention" | "in_review" | "done" | "cancelled";
type Provider = "codex" | "claude";
type ViewMode = "chat" | "board";

interface Workspace { id: string; name: string; rootPath: string; branchPrefix: string; status: string }
interface ProjectLink { id: string; projectId: string; name: string; remoteUrl: string; baseBranch: string; worktreePath: string; branch: string }
interface Task { id: string; title: string; description: string; status: Status; updatedAt: string }
interface Session { id: string; provider: Provider; executorType: "native" | "docker"; runtimeStatus: string; summary: string | null; error: string | null }
interface ConversationMessage { id: string; clientMessageId: string; content: string; status: "queued" | "submitting" | "accepted" | "failed"; error: string | null }
interface EventItem { sequence: number; type: string; occurredAt: string; payload: unknown; taskId?: string | null; sessionId?: string | null; provider?: Provider | null }
interface Interaction { id: string; kind: string; title: string; message: string | null; status: string; riskLevel: string; request: Record<string, unknown>; availableDecisions: string[] }
interface TaskDetails { task: Task; sessions: Session[]; messages: ConversationMessage[]; interactions: Interaction[]; events: EventItem[] }
interface WorkspaceDetails { workspace: Workspace; projects: ProjectLink[]; tasks: TaskDetails[] }
interface ManagedProject { id: string; name: string; remoteUrl: string; localPath: string; baseBranch: string }
interface Change { repositoryId: string; repositoryName: string; worktreePath: string; status: string; diff: string; diffStat: string; commits: string[] }
interface Health { status: string; providers: Record<Provider, { installed: boolean; version?: string }>; executors: Record<"native" | "docker", { ready: boolean; message?: string }> }
interface InspectorItem { title: string; kind: "diff" | "markdown" | "json"; content: string; subtitle?: string }
interface ConversationItem { key: string; kind: "user" | "agent" | "tool" | "error"; title: string; text: string; occurredAt: string; payloads: unknown[] }

const columns: Array<{ key: Status; title: string }> = [
  { key: "todo", title: "To Do" }, { key: "in_progress", title: "In Progress" },
  { key: "needs_attention", title: "Needs Attention" }, { key: "in_review", title: "In Review" },
  { key: "done", title: "Done" }, { key: "cancelled", title: "Cancelled" },
];

function clean(value: string): string { return value.trim(); }
function stripAnsi(value: string): string { return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""); }
function errorText(value: unknown): string {
  if (typeof value === "string") {
    try { return errorText(JSON.parse(value)); } catch { return stripAnsi(value); }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.message !== undefined) return errorText(record.message);
    if (record.error !== undefined) return errorText(record.error);
  }
  return JSON.stringify(value, null, 2);
}
function payloadText(payload: unknown): string {
  if (typeof payload === "string") return stripAnsi(payload);
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  const value = payload as Record<string, unknown>;
  if (typeof value.text === "string") return stripAnsi(value.text);
  if (typeof value.data === "string") return stripAnsi(value.data);
  if (typeof value.result === "string") return stripAnsi(value.result);
  const message = value.message as Record<string, unknown> | undefined;
  if (message && Array.isArray(message.content)) {
    const text = message.content.map((item) => typeof item === "object" && item && "text" in item ? String((item as { text: unknown }).text) : "").filter(Boolean).join("\n");
    if (text) return text;
  }
  return JSON.stringify(payload, null, 2);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function agentMessagePart(event: EventItem): { key: string; text: string; completed: boolean } {
  const payload = record(event.payload);
  const item = record(payload.item);
  const nestedEvent = record(payload.event);
  const nestedDelta = record(nestedEvent.delta);
  const message = record(payload.message);
  const key = String(payload.itemId ?? item.id ?? message.id ?? payload.turnId ?? `${event.sequence}`);
  const text = typeof payload.delta === "string" ? payload.delta
    : typeof item.text === "string" ? item.text
      : typeof nestedDelta.text === "string" ? nestedDelta.text
        : payloadText(event.payload);
  return { key, text: stripAnsi(text), completed: event.type === "message.completed" || (event.type === "tool.completed" && item.type === "agentMessage") };
}

function toolTitle(payload: unknown): string {
  const value = record(payload);
  if (typeof value.toolCallName === "string" && value.toolCallName) return value.toolCallName;
  const item = record(value.item);
  const type = String(item.type ?? value.type ?? "Tool call");
  const readableType = type.replace(/([a-z])([A-Z])/g, "$1 $2");
  const name = item.name ?? item.toolName ?? item.command;
  return typeof name === "string" && name ? `${readableType}: ${name}` : readableType;
}

export function conversationItems(events: EventItem[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const agents = new Map<string, number>();
  const agUiItems = new Map<string, number>();
  const upsertAgUi = (
    key: string,
    kind: ConversationItem["kind"],
    title: string,
    event: EventItem,
    text = "",
    replace = false,
  ): ConversationItem => {
    const existingIndex = agUiItems.get(key);
    if (existingIndex === undefined) {
      const item = { key, kind, title, text, occurredAt: event.occurredAt, payloads: [event.payload] };
      agUiItems.set(key, items.length);
      items.push(item);
      return item;
    }
    const item = items[existingIndex] as ConversationItem;
    item.text = replace ? text : `${item.text}${text}`;
    item.occurredAt = event.occurredAt;
    item.payloads.push(event.payload);
    return item;
  };
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const agUi = record(event.payload);
    const agUiType = typeof agUi.type === "string" ? agUi.type : event.type;
    if (agUiType === "TEXT_MESSAGE_START") {
      const messageId = String(agUi.messageId ?? event.sequence);
      const isUser = agUi.role === "user";
      upsertAgUi(`message-${messageId}`, isUser ? "user" : "agent", isUser ? "You" : "Agent", event);
      continue;
    }
    if (agUiType === "TEXT_MESSAGE_CONTENT" || agUiType === "TEXT_MESSAGE_CHUNK") {
      const messageId = String(agUi.messageId ?? event.sequence);
      upsertAgUi(`message-${messageId}`, agUi.role === "user" ? "user" : "agent", agUi.role === "user" ? "You" : "Agent", event, stripAnsi(String(agUi.delta ?? "")));
      continue;
    }
    if (agUiType === "TEXT_MESSAGE_END") {
      const messageId = String(agUi.messageId ?? event.sequence);
      upsertAgUi(`message-${messageId}`, "agent", "Agent", event);
      continue;
    }
    if (agUiType === "REASONING_MESSAGE_START") {
      const messageId = String(agUi.messageId ?? event.sequence);
      upsertAgUi(`reasoning-${messageId}`, "agent", "Reasoning", event);
      continue;
    }
    if (agUiType === "REASONING_MESSAGE_CONTENT" || agUiType === "REASONING_MESSAGE_CHUNK") {
      const messageId = String(agUi.messageId ?? event.sequence);
      upsertAgUi(`reasoning-${messageId}`, "agent", "Reasoning", event, stripAnsi(String(agUi.delta ?? "")));
      continue;
    }
    if (agUiType === "REASONING_MESSAGE_END") {
      const messageId = String(agUi.messageId ?? event.sequence);
      upsertAgUi(`reasoning-${messageId}`, "agent", "Reasoning", event);
      continue;
    }
    if (agUiType === "TOOL_CALL_START") {
      const toolCallId = String(agUi.toolCallId ?? event.sequence);
      upsertAgUi(`tool-${toolCallId}`, "tool", String(agUi.toolCallName ?? "Tool call"), event);
      continue;
    }
    if (agUiType === "TOOL_CALL_ARGS") {
      const toolCallId = String(agUi.toolCallId ?? event.sequence);
      upsertAgUi(`tool-${toolCallId}`, "tool", "Tool call", event, String(agUi.delta ?? ""));
      continue;
    }
    if (agUiType === "TOOL_CALL_RESULT") {
      const toolCallId = String(agUi.toolCallId ?? event.sequence);
      upsertAgUi(`tool-${toolCallId}`, "tool", "Tool call", event, String(agUi.content ?? ""), true);
      continue;
    }
    if (agUiType === "TOOL_CALL_END") {
      const toolCallId = String(agUi.toolCallId ?? event.sequence);
      upsertAgUi(`tool-${toolCallId}`, "tool", "Tool call", event);
      continue;
    }
    if (agUiType === "RUN_ERROR") {
      upsertAgUi(`error-${event.sequence}`, "error", "Agent error", event, errorText(agUi.message ?? agUi));
      continue;
    }
    const completedItemType = event.type === "tool.completed" ? String(record(record(event.payload).item).type ?? "") : "";
    if (event.type === "message.delta" || event.type === "message.completed" || completedItemType === "agentMessage") {
      const part = agentMessagePart(event);
      const existingIndex = agents.get(part.key);
      if (existingIndex === undefined) {
        agents.set(part.key, items.length);
        items.push({ key: `agent-${part.key}`, kind: "agent", title: "Agent", text: part.text, occurredAt: event.occurredAt, payloads: [event.payload] });
      } else {
        const existing = items[existingIndex];
        if (!existing) continue;
        existing.text = part.completed && part.text ? part.text : `${existing.text}${part.text}`;
        existing.occurredAt = event.occurredAt;
        existing.payloads.push(event.payload);
      }
      continue;
    }
    if (event.type === "message.user") {
      items.push({ key: `user-${event.sequence}`, kind: "user", title: "You", text: payloadText(event.payload), occurredAt: event.occurredAt, payloads: [event.payload] });
    } else if (event.type === "tool.completed" && completedItemType !== "userMessage") {
      items.push({ key: `tool-${event.sequence}`, kind: "tool", title: toolTitle(event.payload), text: payloadText(event.payload), occurredAt: event.occurredAt, payloads: [event.payload] });
    } else if (event.type === "session.error" || event.type === "session.failed") {
      items.push({ key: `error-${event.sequence}`, kind: "error", title: "Agent error", text: errorText(event.payload), occurredAt: event.occurredAt, payloads: [event.payload] });
    }
  }
  return items;
}

function Modal({ title, description, children, busy, submitLabel, onClose, onSubmit }: { title: string; description?: string; children: React.ReactNode; busy?: boolean; submitLabel: string; onClose(): void; onSubmit(event: React.FormEvent): void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><form className="modal" aria-label={title} onSubmit={onSubmit}>
    <header><div><p className="eyebrow">AGENTS-WORKSPACES</p><h2>{title}</h2>{description && <p>{description}</p>}</div><button type="button" className="icon" onClick={onClose}>×</button></header>
    <div className="modal-fields">{children}</div><footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button disabled={busy} type="submit">{busy ? "Working…" : submitLabel}</button></footer>
  </form></div>;
}

function InteractionCard({ interaction, onResolved }: { interaction: Interaction; onResolved(): void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  async function respond(payload: Record<string, unknown>) { setBusy(true); try { await post(`/api/interactions/${interaction.id}/respond`, payload); onResolved(); } finally { setBusy(false); } }
  const decisions = interaction.availableDecisions.length ? interaction.availableDecisions : ["accept", "decline"];
  return <article className={`chat-message interaction risk-${interaction.riskLevel}`}><div className="message-head"><strong>Needs your attention</strong><span>{interaction.riskLevel}</span></div><h4>{interaction.title}</h4>{interaction.message && <p>{interaction.message}</p>}
    {(interaction.kind === "question" || interaction.kind === "form") && <textarea placeholder="Enter your answer…" value={answer} onChange={(event) => setAnswer(event.target.value)} />}
    <div className="button-row">{interaction.kind === "question" || interaction.kind === "form" ? <><button disabled={busy || !answer.trim()} onClick={() => void respond(interaction.kind === "question" ? { answers: { answer: { answers: [answer] } } } : { action: "accept", content: { answer } })}>Submit</button><button className="secondary" onClick={() => void respond({ decision: "cancel", action: "decline" })}>Cancel</button></> : decisions.map((decision) => <button className={decision.includes("deny") || decision.includes("decline") ? "danger" : ""} disabled={busy} key={decision} onClick={() => void respond({ decision })}>{decision}</button>)}</div>
  </article>;
}

function StatusTag({ status }: { status: Status }) { return <span className={`status-tag ${status}`}>{status.replace("_", " ")}</span>; }

function MarkdownContent({ content }: { content: string }) {
  const blocks = content.split(/\n{2,}/).filter(Boolean);
  return <div className="markdown-view">{blocks.map((block, index) => {
    const heading = block.match(/^(#{1,4})\s+(.+)$/s);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      return level === 1 ? <h1 key={index}>{text}</h1> : level === 2 ? <h2 key={index}>{text}</h2> : <h3 key={index}>{text}</h3>;
    }
    if (block.startsWith("```") && block.endsWith("```")) return <pre key={index}><code>{block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code></pre>;
    const lines = block.split("\n");
    if (lines.every((line) => /^[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{line.replace(/^[-*]\s+/, "")}</li>)}</ul>;
    return <p key={index}>{block}</p>;
  })}</div>;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceDetails[]>([]);
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem("aw-view") as ViewMode) || "chat");
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeTaskDetails, setActiveTaskDetails] = useState<TaskDetails | null>(null);
  const [inspector, setInspector] = useState<InspectorItem | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [modal, setModal] = useState<"workspace" | "project" | "projects" | "task" | "settings" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshVersion = useRef(0);
  const taskRequestVersion = useRef(0);

  const activeWorkspace = workspaces.find((item) => item.workspace.id === activeWorkspaceId) ?? null;
  const allTasks = useMemo(() => workspaces.flatMap((workspace) => workspace.tasks.map((task) => ({ ...task, workspace }))), [workspaces]);
  const activeSummary = allTasks.find((item) => item.task.id === activeTaskId) ?? null;
  const activeEntry = activeSummary
    ? { ...(activeTaskDetails?.task.id === activeTaskId ? activeTaskDetails : activeSummary), workspace: activeSummary.workspace }
    : null;
  const boardTasks = workspaceFilter === "all" ? allTasks : allTasks.filter((item) => item.workspace.workspace.id === workspaceFilter);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const result = await api<{ items: WorkspaceDetails[] }>("/api/workspaces");
      if (version !== refreshVersion.current) return;
      setWorkspaces(result.items);
      setActiveWorkspaceId((current) => current && result.items.some((item) => item.workspace.id === current) ? current : result.items[0]?.workspace.id ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);

  const loadTask = useCallback(async (taskId: string) => {
    const version = ++taskRequestVersion.current;
    try {
      const result = await api<TaskDetails>(`/api/tasks/${taskId}`);
      if (version !== taskRequestVersion.current) return;
      setActiveTaskDetails((current) => {
        if (!current || current.task.id !== taskId) return result;
        const events = new Map(result.events.map((event) => [event.sequence, event]));
        for (const event of current.events) if (!events.has(event.sequence)) events.set(event.sequence, event);
        return { ...result, events: [...events.values()].sort((a, b) => a.sequence - b.sequence) };
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);

  useEffect(() => { void Promise.all([api<Health>("/api/health").then(setHealth), refresh()]); }, [refresh]);
  useEffect(() => { localStorage.setItem("aw-view", view); }, [view]);
  useEffect(() => {
    if (!activeTaskId) { setActiveTaskDetails(null); return; }
    setActiveTaskDetails(null);
    void loadTask(activeTaskId);
  }, [activeTaskId, loadTask]);
  useEffect(() => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events/ws?snapshot=0`);
    let summaryTimer: number | undefined;
    let detailTimer: number | undefined;
    socket.addEventListener("message", (message) => {
      let envelope: { type?: string; event?: EventItem };
      try { envelope = JSON.parse(String(message.data)) as { type?: string; event?: EventItem }; } catch { return; }
      const event = envelope.type === "event" ? envelope.event : undefined;
      if (!event) return;
      if (event.taskId === activeTaskId) {
        setActiveTaskDetails((current) => current && current.task.id === activeTaskId && !current.events.some((item) => item.sequence === event.sequence)
          ? { ...current, events: [...current.events, event].sort((a, b) => a.sequence - b.sequence) }
          : current);
      }
      const changesState = ![
        "message.delta", "message.completed", "tool.started", "tool.completed", "provider.event", "session.log",
        "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "TEXT_MESSAGE_CHUNK",
        "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT", "TOOL_CALL_CHUNK",
        "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END", "REASONING_MESSAGE_CHUNK", "REASONING_END",
        "RAW", "CUSTOM",
      ].includes(event.type);
      if (!changesState) return;
      if (summaryTimer === undefined) summaryTimer = window.setTimeout(() => { summaryTimer = undefined; void refresh(); }, 120);
      if (event.taskId === activeTaskId && detailTimer === undefined) detailTimer = window.setTimeout(() => { detailTimer = undefined; if (activeTaskId) void loadTask(activeTaskId); }, 120);
    });
    return () => {
      socket.close();
      if (summaryTimer !== undefined) window.clearTimeout(summaryTimer);
      if (detailTimer !== undefined) window.clearTimeout(detailTimer);
    };
  }, [activeTaskId, loadTask, refresh]);
  useEffect(() => {
    if (!activeTaskId) { setChanges([]); return; }
    void api<{ items: Change[] }>(`/api/tasks/${activeTaskId}/changes`).then((result) => setChanges(result.items)).catch(() => setChanges([]));
  }, [activeTaskId]);

  async function run(work: () => Promise<unknown>) { setBusy(true); setError(null); try { await work(); setModal(null); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }

  function selectTask(workspaceId: string, taskId: string) { setActiveWorkspaceId(workspaceId); setActiveTaskId(taskId); setInspector(null); }

  return <main className="app-shell">
    <header className="app-topbar">
      <div className="brand"><div className="brand-mark">AW</div><div><p className="eyebrow">LOCAL AGENT CONTROL PLANE</p><h1>Agents-Workspaces</h1></div></div>
      <div className="view-switch"><button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>Chat</button><button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>Board</button></div>
      <div className="top-actions">
        {view === "board" && <select aria-label="Workspace filter" value={workspaceFilter} onChange={(event) => { const value = event.target.value; setWorkspaceFilter(value); if (value !== "all") setActiveWorkspaceId(value); }}><option value="all">All Workspaces</option>{workspaces.map((item) => <option key={item.workspace.id} value={item.workspace.id}>{item.workspace.name}</option>)}</select>}
        <button className="secondary" onClick={() => setModal("projects")}>Projects</button>
        <button className="secondary" onClick={() => setModal("workspace")}>+ Workspace</button>
        <button className="secondary" disabled={!activeWorkspace} onClick={() => setModal("project")}>+ Add Project</button>
        <button disabled={!activeWorkspace?.projects.length} onClick={() => setModal("task")}>+ Task</button>
        <button className="icon settings" aria-label="Global settings" onClick={() => setModal("settings")}>⚙</button>
      </div>
    </header>
    {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}

    {view === "chat" ? <section className={`chat-layout ${inspector ? "with-inspector" : ""}`}>
      <aside className="workspace-sidebar">
        <div className="sidebar-title"><span>Workspaces</span><button onClick={() => setModal("workspace")}>+</button></div>
        {workspaces.map((item) => <section className={`workspace-group ${activeWorkspaceId === item.workspace.id ? "active" : ""}`} key={item.workspace.id}>
          <button className="workspace-row" onClick={() => { setActiveWorkspaceId(item.workspace.id); setActiveTaskId(null); }}><span className="folder-icon">⌑</span><strong>{item.workspace.name}</strong><small>{item.projects.length}</small></button>
          <div className="workspace-project-list"><span>Projects</span>{item.projects.map((project) => <button key={project.projectId} title={project.worktreePath} onClick={() => setInspector({ title: project.name, kind: "markdown", content: `# ${project.name}\n\nRemote: ${project.remoteUrl}\n\nWorktree: ${project.worktreePath}\n\nBranch: \`${project.branch}\`` })}>{project.name}</button>)}</div>
          {item.tasks.map((details) => <button className={`sidebar-task ${activeTaskId === details.task.id ? "selected" : ""}`} key={details.task.id} onClick={() => selectTask(item.workspace.id, details.task.id)}><span>{details.task.title}</span><StatusTag status={details.task.status} /></button>)}
          {activeWorkspaceId === item.workspace.id && <div className="sidebar-actions"><button onClick={() => setModal("project")}>+ Project</button><button disabled={!item.projects.length} onClick={() => setModal("task")}>+ Task</button></div>}
        </section>)}
        {!workspaces.length && <div className="sidebar-empty">Create a Workspace to begin.</div>}
      </aside>
      <ChatPane entry={activeEntry} changes={changes} onRefresh={refresh} onInspect={setInspector} onCreateTask={() => setModal("task")} />
      {inspector && <Inspector item={inspector} onClose={() => setInspector(null)} />}
    </section> : <section className={`board-layout ${activeEntry ? "with-chat" : ""} ${inspector ? "with-inspector" : ""}`}>
      <div className="board"><div className="board-summary"><strong>{boardTasks.length} tasks</strong><span>{workspaceFilter === "all" ? "Across all Workspaces" : workspaces.find((item) => item.workspace.id === workspaceFilter)?.workspace.name}</span></div><div className="board-columns">{columns.map((column) => <article className="column" key={column.key}><header><span className={`dot ${column.key}`} /><h2>{column.title}</h2><span>{boardTasks.filter((item) => item.task.status === column.key).length}</span></header><div>{boardTasks.filter((item) => item.task.status === column.key).map((entry) => <button className={`task-card ${activeTaskId === entry.task.id ? "selected" : ""}`} key={entry.task.id} onClick={() => selectTask(entry.workspace.workspace.id, entry.task.id)}><strong>{entry.task.title}</strong><p>{entry.task.description}</p>{workspaceFilter === "all" && <span className="workspace-chip">{entry.workspace.workspace.name}</span>}<div className="card-meta"><span>{entry.interactions.filter((item) => item.status === "pending").length} waiting</span><span>{entry.workspace.projects.length} projects</span></div></button>)}</div></article>)}</div></div>
      {activeEntry && <ChatPane compact entry={activeEntry} changes={changes} onRefresh={refresh} onInspect={setInspector} onClose={() => { setActiveTaskId(null); setInspector(null); }} onCreateTask={() => setModal("task")} />}
      {inspector && <Inspector item={inspector} onClose={() => setInspector(null)} />}
    </section>}

    {modal === "workspace" && <WorkspaceModal busy={busy} onClose={() => setModal(null)} onSubmit={(value) => run(async () => { const created = await post<Workspace>("/api/workspaces", value); setActiveWorkspaceId(created.id); })} />}
    {modal === "project" && activeWorkspace && <ProjectModal workspace={activeWorkspace.workspace} busy={busy} onClose={() => setModal(null)} onSubmit={(value) => run(() => post(`/api/workspaces/${activeWorkspace.workspace.id}/projects`, value))} />}
    {modal === "task" && activeWorkspace && <TaskModal workspace={activeWorkspace.workspace} health={health} busy={busy} onClose={() => setModal(null)} onSubmit={(value) => run(async () => { const result = await post<TaskDetails>(`/api/workspaces/${activeWorkspace.workspace.id}/tasks`, value); setActiveTaskId(result.task.id); })} />}
    {modal === "projects" && <ProjectsOverview workspaces={workspaces} onClose={() => setModal(null)} />}
    {modal === "settings" && <SettingsModal health={health} onClose={() => setModal(null)} />}
  </main>;
}

function ChatPane({ entry, changes, compact, onRefresh, onInspect, onClose, onCreateTask }: { entry: (TaskDetails & { workspace: WorkspaceDetails }) | null; changes: Change[]; compact?: boolean; onRefresh(): Promise<void>; onInspect(item: InspectorItem): void; onClose?(): void; onCreateTask(): void }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const clientMessageId = useRef<string | null>(null);
  useEffect(() => { setSendError(null); clientMessageId.current = null; }, [entry?.task.id]);
  if (!entry) return <section className="chat-pane blank"><div><div className="empty-orbit">AW</div><h2>Select a Task</h2><p>Open an existing Agent conversation or start a new Task in this Workspace.</p><button onClick={onCreateTask}>+ New Task</button></div></section>;
  const session = entry.sessions.at(-1);
  const taskId = entry.task.id;
  async function send() {
    if (!message.trim() || sending) return;
    setSending(true);
    setSendError(null);
    const deliveryId = clientMessageId.current ?? crypto.randomUUID();
    clientMessageId.current = deliveryId;
    try {
      await post(`/api/tasks/${taskId}/messages`, { message: clean(message), clientMessageId: deliveryId });
      setMessage("");
      clientMessageId.current = null;
      await onRefresh();
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
      await onRefresh();
    } finally {
      setSending(false);
    }
  }
  const messages = conversationItems(entry.events);
  const failedMessages = entry.messages?.filter((item) => item.status === "failed") ?? [];
  const resumable = session?.runtimeStatus === "suspended";
  return <section className={`chat-pane ${compact ? "compact" : ""}`}><header className="chat-header"><div><StatusTag status={entry.task.status} /><h2>{entry.task.title}</h2><p>{entry.workspace.workspace.name} · {session ? `${session.provider === "claude" ? "Claude Code" : "Codex"} / ${session.executorType}` : "Not started"}</p></div>{onClose && <button className="icon" onClick={onClose}>×</button>}</header>
    <div className="chat-toolbar"><button className="secondary" onClick={() => onInspect({ title: "Workspace", kind: "markdown", content: `# ${entry.workspace.workspace.name}\n\n${entry.workspace.workspace.rootPath}\n\nBranch: \`${entry.workspace.workspace.branchPrefix}\`` })}>Workspace</button>{changes.map((change) => <button className="secondary" key={change.repositoryId} onClick={() => onInspect({ title: `${change.repositoryName} diff`, subtitle: change.worktreePath, kind: "diff", content: change.diff || change.status || "No changes" })}>{change.repositoryName} diff</button>)}</div>
    {resumable && <div className="resume-banner"><strong>Conversation interrupted · ready to resume</strong><span>Your history is saved. The next message will resume the same {session.provider === "claude" ? "Claude Code" : "Codex"} conversation.</span></div>}
    {session?.error && !resumable && <button className="task-error" onClick={() => onInspect({ title: "Task error", kind: "json", content: errorText(session.error) })}><strong>Task failed</strong><span>{errorText(session.error)}</span><em>Open details</em></button>}
    <div className="chat-scroll"><article className="chat-message user"><div className="message-head"><strong>You</strong></div><p>{entry.task.description}</p></article>
      {messages.map((item) => <article className={`chat-message ${item.kind}`} key={item.key}><div className="message-head"><strong>{item.title}</strong><time>{new Date(item.occurredAt).toLocaleTimeString()}</time></div>{item.kind === "agent" || item.kind === "user" ? <MarkdownContent content={item.text} /> : <pre>{item.text}</pre>}<button className="message-detail" onClick={() => onInspect({ title: item.title, kind: item.kind === "agent" || item.kind === "user" ? "markdown" : "json", content: item.kind === "agent" || item.kind === "user" ? item.text : JSON.stringify(item.payloads.length === 1 ? item.payloads[0] : item.payloads, null, 2) })}>Open details</button></article>)}
      {entry.interactions.filter((item) => item.status === "pending").map((interaction) => <InteractionCard interaction={interaction} onResolved={() => void onRefresh()} key={interaction.id} />)}
      {failedMessages.map((failed) => <article className="chat-message error delivery-error" key={failed.id}><div className="message-head"><strong>Message not delivered</strong></div><p>{failed.content}</p><small>{failed.error}</small><button onClick={() => { setMessage(failed.content); clientMessageId.current = failed.clientMessageId; setSendError(null); }}>Retry this message</button></article>)}
      {!messages.length && !entry.interactions.some((item) => item.status === "pending") && <div className="chat-waiting">Waiting for Agent output…</div>}
    </div>
    <div className="composer">{sendError && <div className="composer-error">{sendError}</div>}<textarea placeholder={resumable ? "Send a message to resume this conversation…" : "Continue working on this Task…"} value={message} onChange={(event) => { setMessage(event.target.value); if (clientMessageId.current && failedMessages.every((item) => item.content !== event.target.value)) clientMessageId.current = null; }} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send(); }} /><div><span>⌘ Enter to send</span><button disabled={sending || !message.trim() || !session} onClick={() => void send()}>{sending ? (resumable ? "Resuming…" : "Sending…") : resumable ? "Resume & Send" : "Send"}</button></div></div>
  </section>;
}

function Inspector({ item, onClose }: { item: InspectorItem; onClose(): void }) { return <aside className="inspector"><header><div><span>{item.kind}</span><h3>{item.title}</h3>{item.subtitle && <p>{item.subtitle}</p>}</div><button className="icon" onClick={onClose}>×</button></header><div className={`inspector-content ${item.kind}`}>{item.kind === "markdown" ? <MarkdownContent content={item.content} /> : <pre>{item.content}</pre>}</div></aside>; }

function WorkspaceModal({ busy, onClose, onSubmit }: { busy: boolean; onClose(): void; onSubmit(value: Record<string, unknown>): void }) { const [name, setName] = useState(""); const [path, setPath] = useState(""); const [branch, setBranch] = useState(""); return <Modal title="Create Workspace" description="A Workspace aggregates Project worktrees and hosts multiple Agent Tasks." busy={busy} submitLabel="Create Workspace" onClose={onClose} onSubmit={(event) => { event.preventDefault(); onSubmit({ name: clean(name), ...(clean(path) ? { rootPath: clean(path) } : {}), ...(clean(branch) ? { branchName: clean(branch) } : {}) }); }}><label><span>Workspace name</span><input required autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Message recall" /></label><label><span>Workspace path (optional)</span><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/me/workspaces/message-recall" /></label><label><span>Shared branch name (optional)</span><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feature/message-recall" /></label></Modal>; }

function ProjectModal({ workspace, busy, onClose, onSubmit }: { workspace: Workspace; busy: boolean; onClose(): void; onSubmit(value: Record<string, unknown>): void }) { const [mode, setMode] = useState<"existing" | "remote" | "local">("existing"); const [value, setValue] = useState(""); const [projects, setProjects] = useState<ManagedProject[]>([]); useEffect(() => { void api<{ items: ManagedProject[] }>("/api/project-registry").then((result) => { setProjects(result.items); setValue(result.items[0]?.id ?? ""); if (!result.items.length) setMode("remote"); }); }, []); return <Modal title="Add Project" description={`Create a worktree inside ${workspace.name}.`} busy={busy} submitLabel="Add to Workspace" onClose={onClose} onSubmit={(event) => { event.preventDefault(); onSubmit(mode === "existing" ? { sourceType: mode, projectId: value } : mode === "remote" ? { sourceType: mode, remoteUrl: clean(value) } : { sourceType: mode, localPath: clean(value) }); }}><div className="source-tabs">{(["existing", "remote", "local"] as const).map((item) => <button type="button" className={mode === item ? "active" : ""} key={item} onClick={() => { setMode(item); setValue(item === "existing" ? projects[0]?.id ?? "" : ""); }}>{item === "existing" ? "Existing" : item === "remote" ? "Clone URL" : "Local repository"}</button>)}</div><label><span>Target Workspace</span><code className="readonly-path">{workspace.rootPath}</code></label>{mode === "existing" ? <label><span>Registered Project</span><select required value={value} onChange={(event) => setValue(event.target.value)}><option value="">Select Project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.baseBranch}</option>)}</select></label> : <label><span>{mode === "remote" ? "Git clone URL" : "Local Git repository path"}</span><input required autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={mode === "remote" ? "git@github.com:org/project.git" : "/Users/me/code/project"} />{mode === "local" && <small>The origin URL is read once; your checkout is not modified.</small>}</label>}</Modal>; }

function TaskModal({ workspace, health, busy, onClose, onSubmit }: { workspace: Workspace; health: Health | null; busy: boolean; onClose(): void; onSubmit(value: Record<string, unknown>): void }) { const [title, setTitle] = useState(""); const [prompt, setPrompt] = useState(""); const [provider, setProvider] = useState<Provider>("codex"); const [executor, setExecutor] = useState<"native" | "docker">("native"); return <Modal title="New Task" description={`Start one Agent CLI process in ${workspace.name}.`} busy={busy} submitLabel="Create & Start" onClose={onClose} onSubmit={(event) => { event.preventDefault(); onSubmit({ title: clean(title), prompt: clean(prompt), provider, executorType: executor, startImmediately: true }); }}><label><span>Task title</span><input required autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Implement message recall API" /></label><label><span>Agent</span><select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}><option value="codex">Codex</option><option value="claude">Claude Code</option></select><small>Authentication is configured once in Global Settings.</small></label><label><span>Execution environment</span><select value={executor} onChange={(event) => setExecutor(event.target.value as "native" | "docker")}><option value="native">Native {health?.executors.native.ready ? "· ready" : "· unavailable"}</option><option value="docker">Docker {health?.executors.docker.ready ? "· ready" : "· unavailable"}</option></select></label><label><span>Initial instruction</span><textarea required value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the outcome, boundaries and responsible Projects…" /></label></Modal>; }

function ProjectsOverview({ workspaces, onClose }: { workspaces: WorkspaceDetails[]; onClose(): void }) {
  const [registry, setRegistry] = useState<ManagedProject[]>([]);
  useEffect(() => { void api<{ items: ManagedProject[] }>("/api/project-registry").then((result) => setRegistry(result.items)); }, []);
  return <div className="modal-backdrop"><section className="modal project-overview"><header><div><p className="eyebrow">PROJECT REGISTRY</p><h2>Projects</h2><p>Global managed clones and their Workspace worktrees.</p></div><button className="icon" onClick={onClose}>×</button></header><div className="project-grid">{registry.map((project) => { const linked = workspaces.flatMap((workspace) => workspace.projects.filter((item) => item.projectId === project.id).map((item) => ({ name: workspace.workspace.name, worktreePath: item.worktreePath }))); return <article key={project.id}><div><h3>{project.name}</h3><span>{project.baseBranch}</span></div><code>{project.remoteUrl}</code><p>{linked.length} linked Workspace{linked.length === 1 ? "" : "s"}</p>{linked.map((workspace) => <div className="project-workspace" key={`${project.id}-${workspace.name}`}><strong>{workspace.name}</strong><code>{workspace.worktreePath}</code></div>)}</article>; })}{!registry.length && <div className="projects-empty">No Projects registered yet. Add one from a Workspace.</div>}</div><footer><button onClick={onClose}>Done</button></footer></section></div>;
}

function SettingsModal({ health, onClose }: { health: Health | null; onClose(): void }) { return <div className="modal-backdrop"><section className="modal settings-modal"><header><div><p className="eyebrow">GLOBAL SETTINGS</p><h2>Authentication & Runtime</h2><p>Provider credentials are configured once and reused by every Task.</p></div><button className="icon" onClick={onClose}>×</button></header><div className="settings-body"><div className="setting-row"><div><strong>Codex</strong><p>{health?.providers.codex.version ?? "Not installed"}</p></div><code>pnpm login:codex</code></div><div className="setting-row"><div><strong>Claude Code</strong><p>{health?.providers.claude.version ?? "Not installed"}</p></div><code>pnpm login:claude</code></div><div className="setting-note"><strong>Native</strong><p>Uses the existing CLI credentials from your macOS user account.</p><strong>Docker</strong><p>Uses persistent Provider credential volumes shared across Task containers.</p></div></div><footer><button onClick={onClose}>Done</button></footer></section></div>; }
