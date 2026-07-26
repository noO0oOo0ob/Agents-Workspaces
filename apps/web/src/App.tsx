import { useCallback, useEffect, useMemo, useState } from "react";
import { api, post } from "./api.js";

type TaskStatus = "todo" | "in_progress" | "needs_attention" | "in_review" | "done" | "cancelled";
type Provider = "codex" | "claude";

interface Project { id: string; name: string; description: string }
interface Repository { id: string; name: string; localPath: string; baseBranch: string }
interface Task { id: string; projectId: string; title: string; description: string; status: TaskStatus; updatedAt: string }
interface Workspace { id: string; rootPath: string; status: string; error: string | null }
interface Session { id: string; provider: Provider; executorType: "native" | "docker"; runtimeStatus: string; summary: string | null; error: string | null; createdAt: string }
interface Interaction {
  id: string; provider: Provider; kind: string; title: string; message: string | null; riskLevel: string;
  request: Record<string, unknown>; availableDecisions: string[]; status: string; createdAt: string;
}
interface TaskDetails { task: Task; workspace: Workspace | null; sessions: Session[]; interactions: Interaction[]; workspaceRepositories: unknown[] }
interface Change { repositoryId: string; repositoryName: string; worktreePath: string; status: string; diff: string; diffStat: string; commits: string[] }
interface Health {
  status: string;
  providers: Record<Provider, { installed: boolean; version?: string; error?: string }>;
  executors: Record<"native" | "docker", { ready: boolean; message?: string }>;
}
interface ExecutionProfile { id: string; name: string; provider: Provider; type: "native" | "docker"; image: string | null }
interface FormField {
  name: string;
  label: string;
  type?: "text" | "textarea" | "select";
  initial?: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
}
interface FormDialogState {
  title: string;
  description?: string;
  submitLabel: string;
  fields: FormField[];
  submit(values: Record<string, string>): Promise<void>;
}

const columns: Array<{ key: TaskStatus; title: string; tone: string }> = [
  { key: "todo", title: "To Do", tone: "neutral" },
  { key: "in_progress", title: "In Progress", tone: "blue" },
  { key: "needs_attention", title: "Needs Attention", tone: "amber" },
  { key: "in_review", title: "In Review", tone: "violet" },
  { key: "done", title: "Done", tone: "green" },
  { key: "cancelled", title: "Cancelled", tone: "red" },
];

const clean = (value: string | undefined): string => value?.trim() ?? "";

function FormDialog({ dialog, busy, onClose }: { dialog: FormDialogState; busy: boolean; onClose(): void }) {
  const initialValues = Object.fromEntries(dialog.fields.map((field) => [field.name, field.initial ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(initialValues);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form className="modal" aria-label={dialog.title} onSubmit={(event) => { event.preventDefault(); void dialog.submit(values); }}>
        <header><div><p className="eyebrow">AGENTS-WORKSPACES</p><h2>{dialog.title}</h2>{dialog.description && <p>{dialog.description}</p>}</div><button type="button" className="icon" disabled={busy} onClick={onClose}>×</button></header>
        <div className="modal-fields">
          {dialog.fields.map((field) => <label key={field.name}><span>{field.label}</span>{field.type === "textarea"
            ? <textarea required={field.required} placeholder={field.placeholder} value={values[field.name] ?? ""} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />
            : field.type === "select"
              ? <select required={field.required} value={values[field.name] ?? ""} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              : <input required={field.required} placeholder={field.placeholder} value={values[field.name] ?? ""} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />}</label>)}
        </div>
        <footer><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={busy}>{busy ? "Working…" : dialog.submitLabel}</button></footer>
      </form>
    </div>
  );
}

function ProviderBadge({ provider }: { provider: Provider }) {
  return <span className={`provider ${provider}`}>{provider === "codex" ? "Codex" : "Claude Code"}</span>;
}

function InteractionPanel({ interaction, onResolved }: { interaction: Interaction; onResolved(): void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const questions = (Array.isArray(interaction.request.questions) ? interaction.request.questions : [])
    .map((value, index) => {
      const question = value as { id?: string; header?: string; question?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> };
      return { ...question, id: question.id ?? question.question ?? `question-${index}` };
    });
  const schema = (interaction.request.requestedSchema ?? {}) as { properties?: Record<string, { title?: string; description?: string; type?: string; enum?: string[] }> };

  async function submit(payload: Record<string, unknown>) {
    setBusy(true);
    try {
      await post(`/api/interactions/${interaction.id}/respond`, payload);
      onResolved();
    } finally { setBusy(false); }
  }

  if (interaction.kind === "question") {
    return (
      <div className="interaction-form">
        {questions.map((question) => (
          <label key={question.id}>
            <span>{question.header ?? question.question ?? question.id}</span>
            {question.options?.length ? (
              <select multiple={question.multiSelect} value={question.multiSelect ? (answers[question.id] ?? "").split(", ").filter(Boolean) : answers[question.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [question.id]: question.multiSelect ? Array.from(event.target.selectedOptions).map((option) => option.value).join(", ") : event.target.value })}>
                <option value="">Choose…</option>
                {question.options.map((option) => <option key={option.label}>{option.label}</option>)}
              </select>
            ) : (
              <textarea value={answers[question.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} />
            )}
          </label>
        ))}
        <div className="button-row"><button disabled={busy} onClick={() => void submit({ answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: [value] }])) })}>Submit answers</button><button className="secondary" disabled={busy} onClick={() => void submit({ decision: "cancel", answers: {} })}>Cancel</button></div>
      </div>
    );
  }

  if (interaction.kind === "form") {
    const properties = Object.entries(schema.properties ?? {});
    return (
      <div className="interaction-form">
        {properties.map(([key, property]) => (
          <label key={key}>
            <span>{property.title ?? key}</span>
            {property.enum ? (
              <select value={answers[key] ?? ""} onChange={(event) => setAnswers({ ...answers, [key]: event.target.value })}>
                <option value="">Choose…</option>
                {property.enum.map((value) => <option key={value}>{value}</option>)}
              </select>
            ) : <input value={answers[key] ?? ""} onChange={(event) => setAnswers({ ...answers, [key]: event.target.value })} />}
          </label>
        ))}
        <div className="button-row">
          <button disabled={busy} onClick={() => void submit({ action: "accept", content: answers })}>Submit</button>
          <button className="secondary" disabled={busy} onClick={() => void submit({ action: "decline", content: null })}>Decline</button>
        </div>
      </div>
    );
  }

  const command = typeof interaction.request.command === "string" ? interaction.request.command : null;
  const decisions = interaction.availableDecisions.length ? interaction.availableDecisions : ["accept", "decline"];
  return (
    <div className="approval">
      {command && <pre>{command}</pre>}
      {interaction.message && <p>{interaction.message}</p>}
      <details><summary>Raw request</summary><pre>{JSON.stringify(interaction.request, null, 2)}</pre></details>
      <div className="button-row">
        {decisions.map((decision) => (
          <button className={decision.includes("decline") || decision === "deny" || decision === "cancel" ? "danger" : decision.includes("Session") ? "secondary" : ""}
            disabled={busy} key={decision} onClick={() => void submit({ decision })}>{decision}</button>
        ))}
      </div>
    </div>
  );
}

function TaskCard({ details, selected, onClick }: { details: TaskDetails; selected: boolean; onClick(): void }) {
  const pending = details.interactions.filter((item) => item.status === "pending").length;
  return (
    <button type="button" className={`task-card ${selected ? "selected" : ""}`} onClick={onClick}>
      <strong>{details.task.title}</strong>
      <p>{details.task.description || "No description"}</p>
      <div className="card-meta">
        <span>{details.sessions.length} agent{details.sessions.length === 1 ? "" : "s"}</span>
        <span>{details.workspaceRepositories.length} repos</span>
        {pending > 0 && <span className="attention-count">{pending} waiting</span>}
      </div>
      <div className="provider-row">
        {details.sessions.map((session) => <ProviderBadge provider={session.provider} key={session.id} />)}
      </div>
    </button>
  );
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [tasks, setTasks] = useState<TaskDetails[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [tab, setTab] = useState<"overview" | "attention" | "changes" | "events">("overview");
  const [events, setEvents] = useState<Array<{ sequence: number; type: string; occurredAt: string; payload: unknown }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<FormDialogState | null>(null);

  const selected = tasks.find((item) => item.task.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const projectResult = await api<{ items: Project[] }>("/api/projects");
      setProjects(projectResult.items);
      const activeProject = projectId || projectResult.items[0]?.id || "";
      if (activeProject !== projectId) setProjectId(activeProject);
      if (!activeProject) { setTasks([]); setRepositories([]); return; }
      const [taskResult, repositoryResult] = await Promise.all([
        api<{ items: TaskDetails[] }>(`/api/tasks?projectId=${encodeURIComponent(activeProject)}`),
        api<{ items: Repository[] }>(`/api/projects/${activeProject}/repositories`),
      ]);
      setTasks(taskResult.items);
      setRepositories(repositoryResult.items);
      if (selectedId && !taskResult.items.some((item) => item.task.id === selectedId)) setSelectedId(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [projectId, selectedId]);

  useEffect(() => { void api<Health>("/api/health").then(setHealth).catch(() => setHealth(null)); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events/ws`);
    socket.addEventListener("message", () => void refresh());
    return () => socket.close();
  }, [refresh]);
  useEffect(() => {
    if (!selectedId) return;
    void api<{ items: typeof events }>(`/api/events?taskId=${selectedId}`).then((result) => setEvents(result.items));
    if (tab === "changes") void api<{ items: Change[] }>(`/api/tasks/${selectedId}/changes`).then((result) => setChanges(result.items)).catch((cause) => setError(String(cause)));
  }, [selectedId, tab]);

  const grouped = useMemo(() => Object.fromEntries(columns.map((column) => [column.key, tasks.filter((item) => item.task.status === column.key)])) as Record<TaskStatus, TaskDetails[]>, [tasks]);

  async function action(work: () => Promise<unknown>, closeDialog = false) {
    setBusy(true); setError(null);
    try { await work(); if (closeDialog) setDialog(null); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  function createProject() {
    setDialog({ title: "Create project", description: "Group the repositories that participate in one product.", submitLabel: "Create project", fields: [
      { name: "name", label: "Project name", required: true, placeholder: "Customer platform" },
      { name: "description", label: "Description", type: "textarea", placeholder: "Web, desktop and backend repositories" },
    ], submit: async ({ name, description }) => action(async () => { const project = await post<Project>("/api/projects", { name: clean(name), description: clean(description) }); setProjectId(project.id); }, true) });
  }

  function addRepository() {
    if (!projectId) return;
    setDialog({ title: "Add repository", description: "Use an existing local Git root, or leave it blank and provide a remote URL to clone.", submitLabel: "Add repository", fields: [
      { name: "name", label: "Repository name", required: true, placeholder: "web" },
      { name: "localPath", label: "Local Git root", placeholder: "/Users/me/code/web" },
      { name: "remoteUrl", label: "Remote URL", placeholder: "git@github.com:org/web.git" },
      { name: "baseBranch", label: "Base branch", initial: "main", required: true },
    ], submit: async ({ name, localPath, remoteUrl, baseBranch }) => action(() => post(`/api/projects/${projectId}/repositories`, { name: clean(name), localPath: clean(localPath) || null, remoteUrl: clean(remoteUrl) || null, baseBranch: clean(baseBranch) }), true) });
  }

  function createTask() {
    if (!projectId) return;
    setDialog({ title: "Create task", description: "One task owns one isolated multi-repository Workspace.", submitLabel: "Create task", fields: [
      { name: "title", label: "Task title", required: true, placeholder: "Add order refund flow" },
      { name: "description", label: "Initial requirement", type: "textarea", placeholder: "Describe the desired outcome and constraints" },
    ], submit: async ({ title, description }) => action(async () => { const task = await post<Task>("/api/tasks", { projectId, title: clean(title), description: clean(description) }); setSelectedId(task.id); }, true) });
  }

  function createProfile() {
    setDialog({ title: "Create execution profile", submitLabel: "Create profile", fields: [
      { name: "name", label: "Profile name", initial: "Local Native", required: true },
      { name: "provider", label: "Agent", type: "select", initial: "codex", options: [{ label: "Codex", value: "codex" }, { label: "Claude Code", value: "claude" }] },
      { name: "type", label: "Executor", type: "select", initial: "native", options: [{ label: "Native", value: "native" }, { label: "Docker", value: "docker" }] },
      { name: "image", label: "Docker image (ignored for Native)", initial: "agents-workspaces-runner:local" },
    ], submit: async ({ name, provider, type, image }) => action(() => post("/api/execution-profiles", { name: clean(name), provider, type, image: type === "docker" ? clean(image) : null, environment: {} }), true) });
  }

  function createTaskWorkspace() {
    if (!selected || repositories.length === 0) return;
    setDialog({ title: "Create isolated Workspace", description: "Repository names must match the registered project repositories.", submitLabel: "Create Workspace", fields: [
      { name: "repositories", label: "Repositories (comma-separated)", initial: repositories.map((repo) => repo.name).join(", "), required: true },
      { name: "knowledgeSources", label: "Obsidian Markdown paths (optional, comma-separated)", type: "textarea" },
      { name: "branchName", label: "Task branch (optional)", placeholder: `agent/${selected.task.id}` },
    ], submit: async ({ repositories: repositoryText, knowledgeSources: sourceText, branchName }) => {
      const names = new Set((repositoryText ?? "").split(",").map((value) => value.trim()).filter(Boolean));
      const repositoryIds = repositories.filter((repository) => names.has(repository.name)).map((repository) => repository.id);
      const knowledgeSources = (sourceText ?? "").split(",").map((path) => path.trim()).filter(Boolean).map((path) => ({ path, scope: "project" }));
      await action(() => post(`/api/tasks/${selected.task.id}/workspace`, { repositoryIds, branchName: clean(branchName) || undefined, fetch: false, knowledgeSources }), true);
    } });
  }

  async function startAgent() {
    if (!selected?.workspace) return;
    const result = await api<{ items: ExecutionProfile[] }>("/api/execution-profiles");
    setDialog({ title: "Start Agent", description: "The Agent starts inside this task's aggregated Workspace.", submitLabel: "Start Agent", fields: [
      { name: "provider", label: "Agent", type: "select", initial: "codex", options: [{ label: "Codex", value: "codex" }, { label: "Claude Code", value: "claude" }] },
      { name: "executorType", label: "Executor", type: "select", initial: "native", options: [{ label: "Native", value: "native" }, { label: "Docker", value: "docker" }] },
      { name: "executionProfileId", label: "Execution profile (optional)", type: "select", options: [{ label: "Default", value: "" }, ...result.items.map((profile) => ({ label: `${profile.name} · ${profile.provider}/${profile.type}`, value: profile.id }))] },
      { name: "prompt", label: "Initial instruction", type: "textarea", initial: selected.task.description || selected.task.title, required: true },
    ], submit: async ({ provider, executorType, executionProfileId, prompt }) => action(() => post(`/api/tasks/${selected.task.id}/sessions`, { provider, executorType, prompt: clean(prompt), ...(executionProfileId ? { executionProfileId } : {}) }), true) });
  }

  function saveKnowledge() {
    if (!selected) return;
    setDialog({ title: "Save knowledge candidate", description: "This writes to the Obsidian Inbox and does not automatically become trusted Memory.", submitLabel: "Save candidate", fields: [
      { name: "title", label: "Title", initial: selected.task.title, required: true },
      { name: "content", label: "Content", type: "textarea", initial: selected.sessions.map((session) => session.summary).filter(Boolean).join("\n\n"), required: true },
    ], submit: async ({ title, content }) => action(() => post(`/api/tasks/${selected.task.id}/knowledge-candidates`, { title: clean(title), content: clean(content) }), true) });
  }

  function sendMessage(session: Session) {
    setDialog({ title: "Continue Agent session", submitLabel: "Send instruction", fields: [
      { name: "message", label: "Instruction", type: "textarea", required: true, placeholder: "Address the review feedback…" },
    ], submit: async ({ message }) => action(() => post(`/api/sessions/${session.id}/messages`, { message: clean(message) }), true) });
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark">AW</div><div><p className="eyebrow">LOCAL AGENT CONTROL PLANE</p><h1>Agents-Workspaces</h1></div></div>
        <div className="top-actions">
          <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setSelectedId(null); }}>
            <option value="">Select project</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
          </select>
          <button className="secondary" onClick={createProject}>+ Project</button>
          <button className="secondary" disabled={!projectId} onClick={addRepository}>+ Repository</button>
          <button className="secondary" onClick={createProfile}>+ Profile</button>
          <button disabled={!projectId} onClick={createTask}>+ New task</button>
        </div>
      </header>

      <section className="statusbar">
        <div className={`health ${health?.status === "ok" ? "online" : "offline"}`}><span />{health?.status === "ok" ? "Daemon online" : "Daemon offline"}</div>
        <div className="capability"><ProviderBadge provider="codex" /><span>{health?.providers.codex.installed ? health.providers.codex.version : "not installed"}</span></div>
        <div className="capability"><ProviderBadge provider="claude" /><span>{health?.providers.claude.installed ? health.providers.claude.version : "not installed"}</span></div>
        <div className="capability"><strong>Native</strong><span>{health?.executors.native.ready ? "ready" : "unavailable"}</span></div>
        <div className="capability"><strong>Docker</strong><span>{health?.executors.docker.ready ? "ready" : "unavailable"}</span></div>
      </section>

      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}

      {!projects.length ? (
        <section className="welcome"><div className="brand-mark large">AW</div><h2>Create your first project</h2><p>Group repositories, create isolated worktrees, and run Codex and Claude Code from one board.</p><button onClick={createProject}>Create project</button></section>
      ) : (
        <section className={`workspace ${selected ? "with-detail" : ""}`}>
          <div className="board" aria-label="Task board">
            {columns.map((column) => (
              <article className="column" key={column.key}>
                <header><span className={`dot ${column.tone}`} /><h2>{column.title}</h2><span className="count">{grouped[column.key].length}</span></header>
                <div className="card-list">
                  {grouped[column.key].map((details) => <TaskCard details={details} selected={selectedId === details.task.id} onClick={() => setSelectedId(details.task.id)} key={details.task.id} />)}
                  {!grouped[column.key].length && <div className="empty">No tasks</div>}
                </div>
              </article>
            ))}
          </div>

          {selected && (
            <aside className="detail">
              <header className="detail-header"><div><span className={`status-label ${selected.task.status}`}>{selected.task.status.replace("_", " ")}</span><h2>{selected.task.title}</h2><p>{selected.task.description}</p></div><button className="icon" onClick={() => setSelectedId(null)}>×</button></header>
              <nav className="tabs">
                {(["overview", "attention", "changes", "events"] as const).map((item) => <button className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{item}</button>)}
              </nav>

              <div className="detail-body">
                {tab === "overview" && <>
                  <section className="panel"><h3>Workspace</h3>{selected.workspace ? <><code>{selected.workspace.rootPath}</code><p>{selected.workspace.status}</p></> : <button disabled={busy || !repositories.length} onClick={createTaskWorkspace}>Create isolated Workspace</button>}</section>
                  <section className="panel"><div className="section-title"><h3>Agent sessions</h3>{selected.workspace?.status === "ready" && <button onClick={startAgent}>+ Start Agent</button>}</div>
                    {selected.sessions.map((session) => <div className="session" key={session.id}><div><ProviderBadge provider={session.provider} /><strong>{session.runtimeStatus}</strong><span>{session.executorType}</span></div><div className="button-row"><button className="secondary" onClick={() => sendMessage(session)}>Continue</button><button className="danger" onClick={() => void action(() => post(`/api/sessions/${session.id}/terminate`))}>Stop</button></div>{session.summary && <p>{session.summary}</p>}{session.error && <pre>{session.error}</pre>}</div>)}
                    {!selected.sessions.length && <p className="muted">No Agent sessions yet.</p>}
                  </section>
                  <section className="panel actions"><h3>Task actions</h3><div className="button-row">{selected.task.status === "in_review" && <><button onClick={() => void action(() => post(`/api/tasks/${selected.task.id}/review/approve`))}>Approve & Done</button><button className="secondary" onClick={() => void action(() => post(`/api/tasks/${selected.task.id}/review/request-changes`))}>Request changes</button></>}<button className="secondary" onClick={saveKnowledge}>Save knowledge candidate</button>{selected.workspace && <button className="danger" onClick={() => { if (window.confirm("Remove all task worktrees? Uncommitted changes will block cleanup.")) void action(() => post(`/api/tasks/${selected.task.id}/workspace/cleanup`, { force: false })); }}>Clean Workspace</button>}<button className="danger" onClick={() => void action(() => post(`/api/tasks/${selected.task.id}/cancel`))}>Cancel</button></div></section>
                </>}

                {tab === "attention" && <>{selected.interactions.filter((item) => item.status === "pending").map((interaction) => <section className={`panel interaction risk-${interaction.riskLevel}`} key={interaction.id}><div className="section-title"><div><ProviderBadge provider={interaction.provider} /><h3>{interaction.title}</h3></div><span className="risk">{interaction.riskLevel}</span></div><InteractionPanel interaction={interaction} onResolved={() => void refresh()} /></section>)}{!selected.interactions.some((item) => item.status === "pending") && <div className="blank-state"><h3>No pending input</h3><p>This task is not waiting for your attention.</p></div>}</>}

                {tab === "changes" && <>{changes.map((change) => <section className="panel change" key={change.repositoryId}><div className="section-title"><h3>{change.repositoryName}</h3><code>{change.commits.length} commits</code></div><pre className="stat">{change.diffStat || change.status || "No changes"}</pre>{change.commits.length > 0 && <ul>{change.commits.map((commit) => <li key={commit}>{commit}</li>)}</ul>}<details><summary>View diff</summary><pre className="diff">{change.diff || "No diff against base branch"}</pre></details></section>)}{!changes.length && <div className="blank-state"><h3>No changes</h3><p>Create a Workspace and run an Agent to see repository diffs.</p></div>}</>}

                {tab === "events" && <div className="timeline">{events.map((event) => <div className="event" key={event.sequence}><span>{new Date(event.occurredAt).toLocaleTimeString()}</span><strong>{event.type}</strong><details><summary>payload</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details></div>)}</div>}
              </div>
            </aside>
          )}
        </section>
      )}
      {dialog && <FormDialog dialog={dialog} busy={busy} onClose={() => setDialog(null)} />}
    </main>
  );
}
