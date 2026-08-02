import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { describeTools, groupTranscript, type TranscriptEntry as ActivityTranscriptEntry } from '@pi-dashboard/activity-model';
import type { BrowserSnapshot, RuntimeSnapshot, SessionIndexEntry, StartRuntimeRequest, WorkspaceTarget } from '@pi-dashboard/protocol';

const base = (import.meta.env.VITE_DASHBOARD_URL as string | undefined)?.replace(/\/$/, '') ?? '';

function dashboardToken(): string | undefined {
  try { return localStorage.getItem('pi-dashboard-token') ?? undefined; } catch { return undefined; }
}

type SessionResponse = { metadata: SessionIndexEntry; entries: unknown[] };
type DashboardEvent = { type?: string; runtimeId?: string; event?: { type?: string; sessionId?: string; message?: unknown; tool?: unknown } };
type AppError = Error & { code?: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = dashboardToken();
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { 'x-dashboard-token': token } : {}), ...(init?.headers ?? {}) } });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error((body as { error?: string }).error ?? `Request failed (${response.status})`) as AppError; Object.assign(error, body); throw error; }
  return body as T;
}

function useDashboard(): { snapshot: BrowserSnapshot | undefined; error: string | undefined; refresh: () => Promise<void>; lastEvent: DashboardEvent | undefined; reconnectNonce: number } {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>();
  const [error, setError] = useState<string>();
  const [lastEvent, setLastEvent] = useState<DashboardEvent>();
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const refresh = useCallback(async () => {
    try { setSnapshot(await api<BrowserSnapshot>('/api/snapshot')); setError(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    void refresh();
    const url = new URL(`${base || window.location.origin}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(url);
      socket.onopen = () => {
        setReconnectNonce((value) => value + 1);
        void refresh();
        const token = dashboardToken();
        if (token) socket?.send(JSON.stringify({ type: 'auth', token }));
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; snapshot?: BrowserSnapshot };
          if (message.type === 'snapshot' && message.snapshot) setSnapshot(message.snapshot);
          else {
            setLastEvent(message as DashboardEvent);
            void refresh();
          }
        } catch { void refresh(); }
      };
      socket.onclose = () => { if (!stopped) { timer = window.setTimeout(() => { void refresh(); connect(); }, 1000); } };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { stopped = true; if (timer) window.clearTimeout(timer); socket?.close(); };
  }, [refresh]);
  return { snapshot, error, refresh, lastEvent, reconnectNonce };
}

function navigate(pathname: string): void { window.history.pushState({}, '', pathname); window.dispatchEvent(new PopStateEvent('popstate')); }

function useRoute(): string[] {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => { const onPop = () => setPathname(window.location.pathname); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  return pathname.split('/').filter(Boolean);
}

function AuthPrompt() {
  const [value, setValue] = useState('');
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    localStorage.setItem('pi-dashboard-token', value.trim());
    window.location.reload();
  };
  return <main className="shell centered"><h1>Pi Dashboard</h1><p>Enter the browser token printed by the dashboard daemon.</p><form className="auth-form" onSubmit={save}><input aria-label="Dashboard token" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="current-password" /><button type="submit">Connect</button></form></main>;
}

export default function App() {
  const route = useRoute();
  const dashboard = useDashboard();
  if (!dashboard.snapshot) return dashboard.error?.includes('Authentication') ? <AuthPrompt /> : <main className="shell centered"><h1>Pi Dashboard</h1><p className="error">{dashboard.error ?? 'Connecting…'}</p><button onClick={() => void dashboard.refresh()}>Retry</button></main>;
  const content = route[0] === 'sessions' && route[1] ? <SessionView id={route[1]} snapshot={dashboard.snapshot} lastEvent={dashboard.lastEvent} reconnectNonce={dashboard.reconnectNonce} />
    : route[0] === 'workspaces' && route[1] ? <WorkspaceView id={route[1]} snapshot={dashboard.snapshot} />
      : route[0] === 'runtimes' && route[1] ? <RuntimeView id={route[1]} snapshot={dashboard.snapshot} />
        : route[0] === 'new' ? <LaunchView snapshot={dashboard.snapshot} />
          : <Dashboard snapshot={dashboard.snapshot} />;
  return <div className="app"><Header snapshot={dashboard.snapshot} /><main className="shell">{content}</main></div>;
}

function Header({ snapshot }: { snapshot: BrowserSnapshot }) {
  const working = snapshot.runtimes.filter((runtime) => runtime.online !== false && runtime.liveState === 'working').length;
  const waiting = snapshot.runtimes.filter((runtime) => runtime.online !== false && runtime.liveState === 'waiting').length;
  return <header className="topbar"><button className="brand" onClick={() => navigate('/')}>PI AGENT</button><span className="header-stat">{working} working</span><span className="header-stat warning-text">{waiting} waiting</span><PushButton /><button className="header-action" onClick={() => navigate('/new')}>+ Agent</button></header>;
}

function PushButton() {
  const [status, setStatus] = useState<'off' | 'on' | 'unavailable'>('off');
  const enable = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { setStatus('unavailable'); return; }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const keyResponse = await api<{ publicKey: string | null }>('/api/push/vapid-public-key');
    if (!keyResponse.publicKey) { setStatus('unavailable'); return; }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(keyResponse.publicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
    setStatus('on');
  };
  return <button className="push-button" onClick={() => void enable().catch(() => setStatus('unavailable'))}>{status === 'on' ? 'Notifications on' : status === 'unavailable' ? 'Push unavailable' : 'Enable notifications'}</button>;
}

function decodeVapidKey(value: string): ArrayBuffer {
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}

function Dashboard({ snapshot }: { snapshot: BrowserSnapshot }) {
  const groups = new Map<string, { workspace: WorkspaceTarget | undefined; runtimes: RuntimeSnapshot[] }>();
  for (const workspace of snapshot.workspaces) groups.set(workspace.id, { workspace, runtimes: [] });
  for (const runtime of snapshot.runtimes) {
    const workspace = snapshot.workspaces.find((item) => item.canonicalPath === runtime.cwd || runtime.cwd.startsWith(`${item.canonicalPath}/`));
    const key = workspace?.id ?? 'other';
    groups.set(key, groups.get(key) ?? { workspace, runtimes: [] });
    groups.get(key)!.runtimes.push(runtime);
  }
  return <section><div className="section-heading"><div><p className="eyebrow">Operational view</p><h1>Agents</h1></div><span className="muted">{snapshot.sessions.length} recent sessions</span></div>{[...groups.entries()].map(([key, group]) => <div className="workspace-block" key={key}><div className="workspace-title"><button onClick={() => group.workspace && navigate(`/workspaces/${group.workspace.id}`)}>{group.workspace?.name ?? 'Other runtimes'}</button><span>{group.runtimes.length} active</span></div>{group.runtimes.length ? group.runtimes.map((runtime) => <RuntimeCard key={runtime.runtimeId} runtime={runtime} />) : <p className="empty">No active runtimes · {group.workspace?.active ? 'Start one' : 'Open through Sesh first'}</p>}</div>)}{groups.size === 0 && <p className="empty">No Sesh workspaces discovered.</p>}</section>;
}

function RuntimeCard({ runtime }: { runtime: RuntimeSnapshot }) {
  const status = runtime.online === false ? 'Offline' : runtime.liveState;
  return <button className={`runtime-card ${runtime.liveState}`} onClick={() => navigate(`/sessions/${encodeURIComponent(runtime.session.id)}`)}><span className="status-dot" /><span className="runtime-main"><strong>{runtime.session.name ?? runtime.session.id.slice(0, 8)}</strong><span>{status} · {runtime.model ? `${runtime.model.provider}/${runtime.model.model}` : 'model unavailable'}</span></span><span className="runtime-owner">{runtime.ownership}</span></button>;
}

function WorkspaceView({ id, snapshot }: { id: string; snapshot: BrowserSnapshot }) {
  const workspace = snapshot.workspaces.find((item) => item.id === id);
  const runtimes = snapshot.runtimes.filter((runtime) => workspace && (runtime.cwd === workspace.canonicalPath || runtime.cwd.startsWith(`${workspace.canonicalPath}/`)));
  const sessions = snapshot.sessions.filter((session) => session.workspaceId === id);
  return <section><Back /><div className="section-heading"><div><p className="eyebrow">Workspace</p><h1>{workspace?.name ?? 'Unknown workspace'}</h1><p className="muted path">{workspace?.canonicalPath}</p></div><button onClick={() => navigate('/new')}>Start agent</button></div>{workspace && !workspace.active && <div className="notice">This workspace has no active tmux session yet. Open it through Sesh on the Mac first.</div>}<h2>Active runtimes</h2>{runtimes.map((runtime) => <RuntimeCard runtime={runtime} key={runtime.runtimeId} />)}{!runtimes.length && <p className="empty">No active runtimes.</p>}<h2>Recent sessions</h2>{sessions.map((session) => <SessionRow key={session.id} session={session} />)}</section>;
}

function SessionRow({ session }: { session: SessionIndexEntry }) { return <button className="session-row" onClick={() => navigate(`/sessions/${encodeURIComponent(session.id)}`)}><span><strong>{session.name ?? session.id.slice(0, 8)}</strong><small>{session.cwd}</small></span><span className="muted">{new Date(session.updatedAt).toLocaleDateString()}</span></button>; }
function Back() { return <button className="back" onClick={() => navigate('/')}>← Dashboard</button>; }

function containsStableId(value: unknown, id: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (stableId(value) === id) return true;
  return Array.isArray(value)
    ? value.some((item) => containsStableId(item, id))
    : Object.values(value as Record<string, unknown>).some((item) => containsStableId(item, id));
}

function stableId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['id', 'messageId', 'toolCallId', 'callId'])
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  for (const key of ['message', 'tool', 'content']) {
    const nested = stableId(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

function replaceStable(value: unknown, id: string, replacement: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (stableId(value) === id) return replacement;
  if (Array.isArray(value)) return value.map((item) => replaceStable(item, id, replacement));
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...record };
  for (const [key, item] of Object.entries(record)) {
    const replaced = replaceStable(item, id, replacement);
    changed ||= replaced !== item;
    next[key] = replaced;
  }
  return changed ? next : value;
}

/** Merge a live bridge item by its Pi-stable id, never by array position. */
export function reconcileLiveEvent(entries: readonly unknown[], event: DashboardEvent['event'], sessionId: string): unknown[] {
  if (!event?.sessionId || event.sessionId !== sessionId) return [...entries];
  const envelope = event.message ?? event.tool;
  const payload = envelope && typeof envelope === 'object'
    ? ((envelope as Record<string, unknown>).message ?? (envelope as Record<string, unknown>).tool ?? envelope)
    : envelope;
  const id = stableId(envelope) ?? stableId(payload);
  if (!payload || !id) return [...entries];
  const isMessage = event.type?.startsWith('message.');
  const tool = payload as Record<string, unknown>;
  const nestedReplacement = isMessage
    ? { type: 'message', message: payload }
    : { ...tool, type: 'toolCall', name: tool.toolName ?? tool.name ?? 'tool', arguments: tool.arguments ?? tool.args };
  const found = entries.some((entry) => containsStableId(entry, id));
  if (found) return entries.map((entry) => replaceStable(entry, id, nestedReplacement));
  return [...entries, isMessage ? nestedReplacement : { type: 'tool', tool: { ...tool, name: tool.toolName ?? tool.name } }];
}

function SessionView({ id, snapshot, lastEvent, reconnectNonce }: { id: string; snapshot: BrowserSnapshot; lastEvent?: DashboardEvent; reconnectNonce: number }) {
  const [data, setData] = useState<SessionResponse>();
  const [error, setError] = useState<string>();
  const runtime = snapshot.runtimes.find((item) => item.session.id === id);
  useEffect(() => { let active = true; void api<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}`).then((value) => active && setData(value)).catch((cause) => active && setError(cause instanceof Error ? cause.message : String(cause))); return () => { active = false; }; }, [id, reconnectNonce]);
  useEffect(() => {
    const event = lastEvent?.event;
    if (!event || !data) return;
    if (event.type === 'agent.settled' || event.type === 'runtime.hello') {
      let active = true;
      void api<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}`).then((value) => active && setData(value)).catch(() => undefined);
      return () => { active = false; };
    }
    if (event.type?.startsWith('message.') || event.type?.startsWith('tool.'))
      setData((current) => current ? { ...current, entries: reconcileLiveEvent(current.entries, event, id) } : current);
  }, [lastEvent, id]);
  if (!data) return <section><Back /><p>{error ?? 'Loading session…'}</p></section>;
  return <section className="session-page"><Back /><div className="session-heading"><div><p className="eyebrow">Session</p><h1>{data.metadata.name ?? id.slice(0, 12)}</h1><p className="muted">{data.metadata.cwd} · {runtime ? runtime.liveState : 'dormant'}</p></div>{runtime && <RuntimeActions runtime={runtime} />}</div>{runtime?.pendingInteractions.map((interaction) => <InteractionCard key={interaction.id} interaction={interaction} />)}<Transcript entries={data.entries} /><Composer runtime={runtime} sessionId={id} /></section>;
}

function RuntimeActions({ runtime }: { runtime: RuntimeSnapshot }) { return <div className="actions"><button onClick={() => void postCommand(runtime.runtimeId, { type: 'abort' })}>Abort</button><button className="danger" onClick={() => void api(`/api/runtimes/${encodeURIComponent(runtime.runtimeId)}/stop`, { method: 'POST', body: '{}' })}>Stop</button></div>; }

function InteractionCard({ interaction }: { interaction: RuntimeSnapshot['pendingInteractions'][number] }) {
  const [answer, setAnswer] = useState('');
  const [sent, setSent] = useState(false);
  const submit = async (value: string) => { await api(`/api/interactions/${encodeURIComponent(interaction.id)}/answer`, { method: 'POST', body: JSON.stringify({ answer: value }) }); setSent(true); };
  if (sent) return <div className="notice">Answered from this dashboard. The other Pi surface will close its question.</div>;
  return <div className="interaction"><p className="eyebrow">Waiting for input</p><h2>{interaction.question}</h2><div className="choices">{interaction.choices.filter((choice) => !choice.custom).map((choice) => <button key={choice.value} onClick={() => void submit(choice.value)}>{choice.label}<small>{choice.description}</small></button>)}</div>{interaction.allowCustom && <form onSubmit={(event) => { event.preventDefault(); if (answer.trim()) void submit(answer.trim()); }}><input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={interaction.customLabel ?? 'Type an answer'} /><button type="submit">Answer</button></form>}<button className="link-button" onClick={() => void api(`/api/interactions/${encodeURIComponent(interaction.id)}/cancel`, { method: 'POST', body: '{}' })}>Cancel</button></div>;
}

interface TranscriptModelItem { entry: ActivityTranscriptEntry; raw: unknown }

function toTranscriptEntries(rawEntries: readonly unknown[]): TranscriptModelItem[] {
  const result: TranscriptModelItem[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') { result.push({ entry: { kind: 'other' }, raw }); continue; }
    const entry = raw as Record<string, unknown>;
    if (entry.type === 'tool') {
      const tool = entry.tool && typeof entry.tool === 'object' ? entry.tool as Record<string, unknown> : entry;
      result.push({ entry: { kind: 'tool', name: typeof tool.name === 'string' ? tool.name : typeof tool.toolName === 'string' ? tool.toolName : 'tool', args: tool.arguments ?? tool.args }, raw });
      continue;
    }
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') { result.push({ entry: { kind: 'other' }, raw }); continue; }
    const message = entry.message as Record<string, unknown>;
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      let spoke = false;
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const part = item as Record<string, unknown>;
        if (part.type === 'toolCall' || part.type === 'tool_call') result.push({ entry: { kind: 'tool', name: typeof part.name === 'string' ? part.name : 'tool', args: part.arguments ?? part.args }, raw: part });
        else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) spoke = true;
      }
      result.push({ entry: { kind: 'assistant', speaks: spoke }, raw });
    } else result.push({ entry: { kind: 'other' }, raw });
  }
  return result;
}

function Transcript({ entries }: { entries: unknown[] }) {
  const items = useMemo(() => toTranscriptEntries(entries), [entries]);
  const modelEntries = useMemo(() => items.map((item) => item.entry), [items]);
  const groups = useMemo(() => groupTranscript(modelEntries), [modelEntries]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const groupByStart = new Map(groups.map((group) => [group.start, group]));
  return <div className="transcript"><h2>Activity</h2>{items.map((item, index) => { const group = groupByStart.get(index); if (group) { const expanded = open.has(group.start); const tools = modelEntries.slice(group.start, group.end + 1).filter((entry): entry is Extract<ActivityTranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool'); const title = describeTools(tools, undefined, true); return <div className="activity-group" key={`group-${group.start}`}><button onClick={() => setOpen((current) => { const next = new Set(current); expanded ? next.delete(group.start) : next.add(group.start); return next; })}><span>●</span><strong>{title}</strong><small>{group.end - group.start + 1} steps · {expanded ? 'collapse' : 'expand'}</small></button>{expanded && <div>{items.slice(group.start, group.end + 1).map((child, offset) => <TranscriptEntry key={offset} raw={child.raw} />)}</div>}</div>; } return <TranscriptEntry key={index} raw={item.raw} />; })}</div>;
}

function TranscriptEntry({ raw }: { raw: unknown }) { const text = JSON.stringify(raw, null, 2); return <details className="transcript-entry"><summary>{typeof raw === 'object' && raw && 'type' in raw ? String((raw as { type?: unknown }).type) : 'entry'}</summary><pre>{text}</pre></details>; }

async function postCommand(runtimeId: string, command: Record<string, unknown>): Promise<void> { await api(`/api/runtimes/${encodeURIComponent(runtimeId)}/command`, { method: 'POST', body: JSON.stringify(command) }); }

function Composer({ runtime }: { runtime: RuntimeSnapshot | undefined; sessionId: string }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'prompt' | 'steer' | 'followUp'>('prompt');
  const disabled = !runtime || runtime.online === false || runtime.liveState === 'stopping' || runtime.liveState === 'waiting';
  useEffect(() => { setMode(runtime?.liveState === 'working' ? 'followUp' : 'prompt'); }, [runtime?.liveState]);
  if (!runtime) return <div className="composer disabled"><p>This session is dormant.</p><button onClick={() => navigate('/new')}>Resume in a new runtime</button></div>;
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!text.trim() || disabled) return; await postCommand(runtime.runtimeId, { type: runtime.liveState === 'idle' ? 'prompt' : mode, text: text.trim() }); setText(''); };
  return <form className="composer" onSubmit={(event) => void submit(event)}><div className="composer-mode">{runtime.liveState === 'working' && <><button type="button" className={mode === 'followUp' ? 'selected' : ''} onClick={() => setMode('followUp')}>Follow-up</button><button type="button" className={mode === 'steer' ? 'selected' : ''} onClick={() => setMode('steer')}>Steer</button></>}{runtime.liveState === 'idle' && <span>Prompt</span>}{runtime.liveState === 'waiting' && <span>Answer above</span>}</div><textarea value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} placeholder={disabled ? 'Agent is waiting for input' : 'Message Pi…'} rows={3} /><button type="submit" disabled={disabled || !text.trim()}>Send</button></form>;
}

function RuntimeView({ id, snapshot }: { id: string; snapshot: BrowserSnapshot }) { const runtime = snapshot.runtimes.find((item) => item.runtimeId === id); return <section><Back /><h1>Runtime diagnostics</h1>{runtime ? <div className="diagnostics"><p>Ownership: <strong>{runtime.ownership}</strong></p><p>PID: {runtime.pid}</p><p>Bridge: {runtime.online === false ? 'offline' : 'connected'}</p><p>Session: {runtime.session.id}</p><p>tmux: {runtime.tmux?.displayTarget ?? 'not reported'}</p><button onClick={() => navigate(`/sessions/${encodeURIComponent(runtime.session.id)}`)}>Open session</button><pre>{JSON.stringify(runtime, null, 2)}</pre></div> : <p>Unknown runtime.</p>}</section>; }

function LaunchView({ snapshot }: { snapshot: BrowserSnapshot }) {
  const [workspaceId, setWorkspaceId] = useState(snapshot.workspaces.find((item) => item.active)?.id ?? '');
  const [sessionId, setSessionId] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const sessions = snapshot.sessions.filter((session) => session.workspaceId === workspaceId);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); const request: StartRuntimeRequest = { workspaceId, ...(sessionId ? { sessionId } : {}), ...(name ? { name } : {}), ...(prompt ? { initialPrompt: prompt } : {}), acknowledgeSharedWorkingDirectory: ack }; try { const result = await api<{ runtimeId: string }>('/api/runtimes/start', { method: 'POST', body: JSON.stringify(request) }); navigate(`/runtimes/${result.runtimeId}`); } catch (cause) { const appError = cause as AppError; setError(appError.message); if (appError.code === 'shared-working-directory') setAck(false); } };
  return <section><Back /><p className="eyebrow">New runtime</p><h1>Start an agent</h1><form className="launch-form" onSubmit={(event) => void submit(event)}><label>Workspace<select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setSessionId(''); }}>{snapshot.workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}{workspace.active ? '' : ' (dormant)'}</option>)}</select></label><label>Resume session (optional)<select value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">New session</option>{sessions.map((session) => <option value={session.id} key={session.id}>{session.name ?? session.id.slice(0, 10)}</option>)}</select></label><label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional session name" /></label><label>Initial prompt<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} /></label>{error && <div className="error">{error}</div>}{error.includes('Both agents') && <label className="check"><input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} /> I understand this shared-working-directory warning and want to start anyway.</label>}<button type="submit" disabled={!workspaceId}>Start in a new tmux window</button></form></section>;
}
