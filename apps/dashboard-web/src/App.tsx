import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { describeTools, groupTranscript, type TranscriptEntry as ActivityTranscriptEntry } from '@pi-dashboard/activity-model';
import type { BrowserSnapshot, RuntimeSnapshot, SessionIndexEntry, StartRuntimeRequest, WorkspaceTarget } from '@pi-dashboard/protocol';

const base = (import.meta.env.VITE_DASHBOARD_URL as string | undefined)?.replace(/\/$/, '') ?? '';

function dashboardToken(): string | undefined {
  try { return localStorage.getItem('pi-dashboard-token') ?? undefined; } catch { return undefined; }
}

type SessionResponse = { metadata: SessionIndexEntry; entries: unknown[] };
export function asSessionResponse(value: unknown): SessionResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const response = value as Partial<SessionResponse>;
  const metadata = response.metadata as Partial<SessionIndexEntry> | undefined;
  if (!metadata || typeof metadata.id !== 'string' || typeof metadata.cwd !== 'string' || !Array.isArray(response.entries)) return undefined;
  return { metadata: metadata as SessionIndexEntry, entries: response.entries };
}
type DashboardEvent = { type?: string; runtimeId?: string; event?: { type?: string; sessionId?: string; message?: unknown; tool?: unknown } };
type AppError = Error & { code?: string };

export function asBrowserSnapshot(value: unknown): BrowserSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const snapshot = value as Partial<BrowserSnapshot>;
  if (!Array.isArray(snapshot.runtimes) || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.sessions)) return undefined;
  return {
    ...snapshot,
    revision: typeof snapshot.revision === 'number' ? snapshot.revision : 0,
    runtimes: snapshot.runtimes,
    workspaces: snapshot.workspaces,
    sessions: snapshot.sessions,
    unread: Array.isArray(snapshot.unread) ? snapshot.unread : [],
  } as BrowserSnapshot;
}

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
    try {
      const next = asBrowserSnapshot(await api<unknown>('/api/snapshot'));
      if (!next) throw new Error('Dashboard returned an invalid snapshot.');
      setSnapshot(next);
      setError(undefined);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    void refresh();
    const url = new URL(`${base || window.location.origin}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let connectTimer: number | undefined;
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
          const message = JSON.parse(event.data) as { type?: string; snapshot?: unknown };
          const next = message.type === 'snapshot' ? asBrowserSnapshot(message.snapshot) : undefined;
          if (next) setSnapshot(next);
          else {
            if (message.type !== 'snapshot') setLastEvent(message as DashboardEvent);
            void refresh();
          }
        } catch { void refresh(); }
      };
      socket.onclose = () => { if (!stopped) { timer = window.setTimeout(() => { void refresh(); connect(); }, 1000); } };
      socket.onerror = () => socket?.close();
    };
    // Delay initial connection by one task so React Strict Mode can complete its
    // development-only mount/unmount probe without closing a CONNECTING socket.
    connectTimer = window.setTimeout(connect, 0);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      if (connectTimer) window.clearTimeout(connectTimer);
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      else if (socket) {
        socket.onopen = () => socket?.close();
        socket.onerror = null;
        socket.onclose = null;
      }
    };
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
  const online = snapshot.runtimes.filter((runtime) => runtime.online !== false).length;
  return <header className="topbar"><div className="rail-inner"><button className="brand" onClick={() => navigate('/')} aria-label="Pi Dashboard home"><span className="prompt">›</span> PI<span className="brand-slash">{'//'}</span>DASHBOARD</button><div className="header-status" aria-label="Runtime status"><span className="header-stat"><i className="status-glyph working-glyph">●</i>{working} working</span><span className="header-stat warning-text"><i className="status-glyph waiting-glyph">◆</i>{waiting} waiting</span><span className="header-stat muted-stat">{online} online</span></div><PushButton /><button className="header-action" onClick={() => navigate('/new')}>+ Agent</button></div></header>;
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
    groups.get(key)?.runtimes.push(runtime);
  }
  const orderedGroups = [...groups.entries()].sort(([, a], [, b]) => {
    const active = (group: typeof a) => group.runtimes.some((runtime) => runtime.online !== false && runtime.liveState !== 'idle');
    return Number(active(b)) - Number(active(a));
  });
  const liveCount = snapshot.runtimes.filter((runtime) => runtime.online !== false).length;
  return <section><div className="section-heading"><div><p className="eyebrow">Operational view</p><h1>Agents</h1></div><span className="muted">{liveCount ? `${liveCount} live runtime${liveCount === 1 ? '' : 's'}` : 'No live runtimes'} · {snapshot.sessions.length} sessions</span></div>{liveCount === 0 && <div className="empty-hero"><span className="empty-mark">›_</span><div><strong>Nothing is running yet.</strong><p>Start an agent to see its work here, or open a workspace through Sesh.</p></div><button onClick={() => navigate('/new')}>Start an agent</button></div>}{orderedGroups.map(([key, group]) => <div className={`workspace-block ${group.runtimes.length ? '' : 'workspace-empty'}`} key={key}><div className="workspace-title"><button onClick={() => group.workspace && navigate(`/workspaces/${group.workspace.id}`)}>{group.workspace?.name ?? 'Other runtimes'}</button><span>{group.runtimes.length ? `${group.runtimes.length} runtime${group.runtimes.length === 1 ? '' : 's'}` : group.workspace?.active ? 'ready' : 'dormant'}</span></div>{group.runtimes.length ? group.runtimes.map((runtime) => <RuntimeCard key={runtime.runtimeId} runtime={runtime} />) : <p className="empty">{group.workspace?.active ? 'Ready for a new runtime.' : 'Open through Sesh to activate this workspace.'}</p>}</div>)}{groups.size === 0 && <p className="empty">No Sesh workspaces discovered.</p>}</section>;
}

function RuntimeCard({ runtime }: { runtime: RuntimeSnapshot }) {
  const status = runtime.online === false ? 'offline' : runtime.liveState;
  const glyph = status === 'working' ? '●' : status === 'waiting' ? '◆' : status === 'failed' ? '×' : status === 'offline' ? '○' : '·';
  const model = runtime.model ? `${runtime.model.provider}/${runtime.model.model}` : 'model unavailable';
  return <button className={`runtime-card ${status}`} onClick={() => navigate(`/sessions/${encodeURIComponent(runtime.session.id)}`)}><span className="runtime-rail"><span className="status-glyph">{glyph}</span></span><span className="runtime-main"><strong>{runtime.session.name ?? runtime.session.id.slice(0, 8)}</strong><span><b>{status}</b> · {model}</span><small>{runtime.cwd} · {runtime.ownership}</small></span><span className="runtime-owner">{runtime.tmux?.displayTarget ?? 'session'}</span></button>;
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
  const toolWrapper = { type: 'tool', tool: { ...tool, name: tool.toolName ?? tool.name } };
  const found = entries.some((entry) => containsStableId(entry, id));
  if (found) return entries.map((entry) => {
    if (!isMessage && entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'tool' && containsStableId(entry, id)) return toolWrapper;
    return replaceStable(entry, id, nestedReplacement);
  });
  return [...entries, isMessage ? nestedReplacement : toolWrapper];
}

function SessionView({ id, snapshot, lastEvent, reconnectNonce }: { id: string; snapshot: BrowserSnapshot; lastEvent?: DashboardEvent; reconnectNonce: number }) {
  const [data, setData] = useState<SessionResponse>();
  const [error, setError] = useState<string>();
  const runtime = snapshot.runtimes.find((item) => item.session.id === id);
  useEffect(() => {
    let active = true;
    void api<unknown>(`/api/sessions/${encodeURIComponent(id)}`)
      .then((value) => {
        const next = asSessionResponse(value);
        if (!next) throw new Error('Dashboard returned invalid session data.');
        if (active) { setData(next); setError(undefined); }
      })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { active = false; };
  }, [id, reconnectNonce]);
  useEffect(() => {
    const event = lastEvent?.event;
    if (!event || !data) return;
    if (event.type === 'agent.settled' || event.type === 'runtime.hello') {
      let active = true;
      void api<unknown>(`/api/sessions/${encodeURIComponent(id)}`).then((value) => {
        const next = asSessionResponse(value);
        if (active && next) setData(next);
      }).catch(() => undefined);
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

interface TranscriptModelItem { entry: ActivityTranscriptEntry; raw: unknown; text?: string; role?: 'user' | 'assistant' }

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  const part = value as Record<string, unknown>;
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content !== 'undefined') return contentText(part.content);
  return '';
}

function messageText(message: Record<string, unknown>): string { return contentText(message.content ?? message.text).trim(); }

function toolRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (record.type === 'tool' && record.tool && typeof record.tool === 'object') return record.tool as Record<string, unknown>;
  if (record.type === 'toolCall' || record.type === 'tool_call' || typeof record.toolName === 'string') return record;
  return undefined;
}

function toTranscriptEntries(rawEntries: readonly unknown[]): TranscriptModelItem[] {
  const result: TranscriptModelItem[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') { result.push({ entry: { kind: 'other' }, raw }); continue; }
    const entry = raw as Record<string, unknown>;
    const tool = entry.type === 'tool' ? toolRecord(raw) : undefined;
    if (tool) {
      result.push({ entry: { kind: 'tool', name: typeof tool.name === 'string' ? tool.name : typeof tool.toolName === 'string' ? tool.toolName : 'tool', args: tool.arguments ?? tool.args }, raw });
      continue;
    }
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') { result.push({ entry: { kind: 'other' }, raw }); continue; }
    const message = entry.message as Record<string, unknown>;
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : undefined;
    const text = messageText(message);
    if (role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      let spoke = Boolean(text);
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const part = item as Record<string, unknown>;
        if (part.type === 'toolCall' || part.type === 'tool_call') result.push({ entry: { kind: 'tool', name: typeof part.name === 'string' ? part.name : 'tool', args: part.arguments ?? part.args }, raw: part });
        else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) spoke = true;
      }
      result.push({ entry: { kind: 'assistant', speaks: spoke }, raw, text, role });
    } else result.push({ entry: { kind: 'other' }, raw, text, role });
  }
  return result;
}

function Transcript({ entries }: { entries: unknown[] }) {
  const items = useMemo(() => toTranscriptEntries(entries), [entries]);
  const modelEntries = useMemo(() => items.map((item) => item.entry), [items]);
  const groups = useMemo(() => groupTranscript(modelEntries), [modelEntries]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const groupByStart = new Map(groups.map((group) => [group.start, group]));
  return <div className="transcript"><h2>Conversation &amp; activity</h2>{items.map((item, index) => { const group = groupByStart.get(index); if (group) { const expanded = open.has(group.start); const tools = modelEntries.slice(group.start, group.end + 1).filter((entry): entry is Extract<ActivityTranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool'); const complete = tools.length > 0 && items.slice(group.start, group.end + 1).filter((item) => item.entry.kind === 'tool').every((item) => toolOutcome(item.raw) === 'success'); const title = describeTools(tools, undefined, complete); const lead = items[group.start]; return <div className={`activity-group ${complete ? 'activity-complete' : 'activity-pending'}`} key={`group-${group.start}`}><button onClick={() => setOpen((current) => { const next = new Set(current); expanded ? next.delete(group.start) : next.add(group.start); return next; })}><span className="activity-icon">{complete ? '✓' : '…'}</span><strong>{title}</strong><small>{tools.length} tool{tools.length === 1 ? '' : 's'} · {expanded ? 'hide detail' : 'show detail'}</small></button>{lead?.text && <div className="activity-lead"><span>assistant</span>{lead.text}</div>}{expanded && <div className="activity-detail">{items.slice(group.start, group.end + 1).map((child, offset) => <TranscriptEntry key={offset} item={child} />)}</div>}</div>; } return <TranscriptEntry key={index} item={item} />; })}</div>;
}

function TranscriptEntry({ item }: { item: TranscriptModelItem }) {
  if (item.role && item.text) return <article className={`message-bubble message-${item.role}`}><span className="message-role">{item.role}</span><div>{item.text}</div></article>;
  const raw = item.raw;
  const tool = toolRecord(raw);
  if (tool) { const name = typeof tool.name === 'string' ? tool.name : typeof tool.toolName === 'string' ? tool.toolName : 'tool'; return <details className="transcript-entry tool-detail"><summary><span className="tool-chip">{name}</span><span>{toolSummary(tool)}</span></summary><pre>{JSON.stringify(raw, null, 2)}</pre></details>; }
  const text = JSON.stringify(raw, null, 2);
  return <details className="transcript-entry"><summary>{typeof raw === 'object' && raw && 'type' in raw ? String((raw as { type?: unknown }).type) : 'entry'}</summary><pre>{text}</pre></details>;
}

function toolOutcome(raw: unknown): 'success' | 'pending' | 'error' {
  const tool = toolRecord(raw);
  if (!tool) return 'pending';
  if (tool.error || tool.status === 'error' || tool.status === 'failed') return 'error';
  if (typeof tool.result !== 'undefined' || tool.status === 'completed' || tool.status === 'success') return 'success';
  return 'pending';
}

function toolSummary(tool: Record<string, unknown>): string { const args = tool.arguments ?? tool.args; if (!args || typeof args !== 'object') return 'activity'; const values = Object.values(args as Record<string, unknown>).filter((value) => typeof value === 'string'); return values[0] ? String(values[0]).slice(0, 100) : 'activity'; }

async function postCommand(runtimeId: string, command: Record<string, unknown>): Promise<void> { await api(`/api/runtimes/${encodeURIComponent(runtimeId)}/command`, { method: 'POST', body: JSON.stringify(command) }); }

function Composer({ runtime }: { runtime: RuntimeSnapshot | undefined; sessionId: string }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'prompt' | 'steer' | 'followUp'>('prompt');
  const disabled = !runtime || runtime.online === false || runtime.liveState === 'stopping' || runtime.liveState === 'waiting';
  useEffect(() => { setMode(runtime?.liveState === 'working' ? 'followUp' : 'prompt'); }, [runtime?.liveState]);
  if (!runtime) return <div className="composer disabled"><p>This session is dormant.</p><button onClick={() => navigate('/new')}>Resume in a new runtime</button></div>;
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!text.trim() || disabled) return; await postCommand(runtime.runtimeId, { type: runtime.liveState === 'idle' ? 'prompt' : mode, text: text.trim() }); setText(''); };
  return <form className="composer" onSubmit={(event) => void submit(event)}><div className="composer-mode">{runtime.liveState === 'working' && <><span>Mode:</span><button type="button" className={mode === 'followUp' ? 'selected' : ''} onClick={() => setMode('followUp')}>Follow-up</button><button type="button" className={mode === 'steer' ? 'selected' : ''} onClick={() => setMode('steer')}>Steer</button></>}{runtime.liveState === 'idle' && <span>Prompt</span>}{runtime.liveState === 'waiting' && <span>Answer above</span>}<span className="shortcut">⌘↵ send · shift+↵ newline</span></div><textarea aria-label="Message Pi" value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} placeholder={disabled ? 'Agent is waiting for input' : 'Message Pi…'} rows={3} /><button type="submit" disabled={disabled || !text.trim()}>Send</button></form>;
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
