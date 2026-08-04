import {
  type TranscriptEntry as ActivityTranscriptEntry,
  describeTools,
  groupTranscript,
} from '@pi-dashboard/activity-model';
import {
  hydrateTranscript,
  reduceTranscriptEvent,
  selectLegacyTranscriptEntries,
  type TranscriptProjection,
} from '@pi-dashboard/domain';
import {
  type BrowserSnapshot,
  deriveSessionTitle,
  type RuntimeSnapshot,
  type SessionIndexEntry,
  type StartRuntimeRequest,
  type WorkspaceTarget,
  workspaceForPath,
} from '@pi-dashboard/protocol';
import {
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type AppError,
  api,
  asSessionResponse,
  type DashboardEvent,
  multipartApi,
  type SessionResponse,
  useDashboard,
} from './dashboard-transport';
import { Markdown } from './Markdown';
import {
  headersOf,
  isNarration,
  type TranscriptModelItem,
  toolOutcome,
  toolRecordForTranscript,
  toolSummary,
  toTranscriptEntries,
} from './transcript';

export {
  api,
  asBrowserSnapshot,
  asSessionResponse,
} from './dashboard-transport';
export { toTranscriptEntries } from './transcript';

export function sessionDisplayTitle(
  session: { name?: string; title?: string },
  entries: readonly unknown[] = [],
): string {
  return (
    session.name ??
    session.title ??
    deriveSessionTitle(entries) ??
    'Untitled session'
  );
}

function navigate(pathname: string): void {
  window.history.pushState({}, '', pathname);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function useRoute(): string[] {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
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
  return (
    <main className="shell centered">
      <h1>Pi Dashboard</h1>
      <p>Enter the browser token printed by the dashboard daemon.</p>
      <form className="auth-form" onSubmit={save}>
        <input
          aria-label="Dashboard token"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="current-password"
        />
        <button type="submit">Connect</button>
      </form>
    </main>
  );
}

export default function App() {
  const route = useRoute();
  const dashboard = useDashboard();
  if (dashboard.error?.includes('Authentication')) return <AuthPrompt />;
  if (!dashboard.snapshot)
    return (
      <main className="shell centered">
        <h1>Pi Dashboard</h1>
        <p className="error">{dashboard.error ?? 'Connecting…'}</p>
        <button type="button" onClick={() => void dashboard.refresh()}>
          Retry
        </button>
      </main>
    );
  const content =
    route[0] === 'sessions' && route[1] ? (
      <SessionView
        id={route[1]}
        snapshot={dashboard.snapshot}
        events={dashboard.events}
        eventGeneration={dashboard.eventGeneration}
        reconnectNonce={dashboard.reconnectNonce}
      />
    ) : route[0] === 'workspaces' && route[1] ? (
      <WorkspaceView id={route[1]} snapshot={dashboard.snapshot} />
    ) : route[0] === 'runtimes' && route[1] ? (
      <RuntimeView id={route[1]} snapshot={dashboard.snapshot} />
    ) : route[0] === 'new' ? (
      <LaunchView snapshot={dashboard.snapshot} />
    ) : (
      <Dashboard
        snapshot={dashboard.snapshot}
        usageError={dashboard.usageError}
      />
    );
  const sessionRoute = route[0] === 'sessions' && Boolean(route[1]);
  return (
    <div className="app">
      <Header snapshot={dashboard.snapshot} />
      <main className={`shell ${sessionRoute ? 'session-shell' : ''}`}>
        {dashboard.error && (
          <div className="notice sync-notice" role="status">
            {dashboard.error}
          </div>
        )}
        {content}
      </main>
    </div>
  );
}

function Header({ snapshot }: { snapshot: BrowserSnapshot }) {
  const working = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false && runtime.liveState === 'working',
  ).length;
  const waiting = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false && runtime.liveState === 'waiting',
  ).length;
  const online = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false,
  ).length;
  return (
    <header className="topbar">
      <div className="rail-inner">
        <button
          type="button"
          className="brand"
          onClick={() => navigate('/')}
          aria-label="Pi Dashboard home"
        >
          <span className="prompt">›</span> PI
          <span className="brand-slash">{'//'}</span>DASHBOARD
        </button>
        <div className="header-status">
          <span className="header-stat">
            <i className="status-glyph working-glyph">●</i>
            {working} working
          </span>
          <span className="header-stat warning-text">
            <i className="status-glyph waiting-glyph">◆</i>
            {waiting} waiting
          </span>
          <span className="header-stat muted-stat">{online} online</span>
        </div>
        <PushButton />
        <button
          type="button"
          className="header-action"
          onClick={() => navigate('/new')}
        >
          + Agent
        </button>
      </div>
    </header>
  );
}

function PushButton() {
  const [status, setStatus] = useState<'off' | 'on' | 'unavailable'>('off');
  const enable = async () => {
    if (
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      setStatus('unavailable');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const keyResponse = await api<{ publicKey: string | null }>(
      '/api/push/vapid-public-key',
    );
    if (!keyResponse.publicKey) {
      setStatus('unavailable');
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(keyResponse.publicKey),
    });
    await api('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription.toJSON()),
    });
    setStatus('on');
  };
  return (
    <button
      type="button"
      className="push-button"
      onClick={() => void enable().catch(() => setStatus('unavailable'))}
    >
      {status === 'on'
        ? 'Notifications on'
        : status === 'unavailable'
          ? 'Push unavailable'
          : 'Enable notifications'}
    </button>
  );
}

function decodeVapidKey(value: string): ArrayBuffer {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}

export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${Number.parseFloat((tokens / 1_000_000).toFixed(1))}m`;
  if (tokens >= 1_000)
    return `${Number.parseFloat((tokens / 1_000).toFixed(1))}k`;
  return `${tokens}`;
}

export function contextIndicatorData(
  usage: RuntimeSnapshot['contextUsage'],
):
  | { percent?: number; text: string; level: 'normal' | 'warning' | 'error' }
  | undefined {
  if (!usage?.contextWindow) return undefined;
  const percent =
    usage.tokens === null
      ? undefined
      : Math.round(usage.percent ?? (usage.tokens / usage.contextWindow) * 100);
  const level =
    percent !== undefined && percent >= 80
      ? 'error'
      : percent !== undefined && percent >= 50
        ? 'warning'
        : 'normal';
  const used = usage.tokens === null ? '?' : formatContextTokens(usage.tokens);
  return {
    percent,
    text: `${percent ?? '?'}% [${used}/${formatContextTokens(usage.contextWindow)}]`,
    level,
  };
}

function ContextIndicator({
  usage,
}: {
  usage: RuntimeSnapshot['contextUsage'];
}) {
  const indicator = contextIndicatorData(usage);
  if (!indicator) return null;
  return (
    <span
      className={`context-indicator context-${indicator.level}`}
      role="img"
      aria-label={`Context window ${indicator.text}`}
      title="Current context window usage"
    >
      <span className="context-label">ctx</span>
      <span className="context-meter" aria-hidden="true">
        <i
          style={{
            width: `${Math.max(0, Math.min(100, indicator.percent ?? 0))}%`,
          }}
        />
      </span>
      <strong>{indicator.text}</strong>
    </span>
  );
}

function Dashboard({
  snapshot,
  usageError,
}: {
  snapshot: BrowserSnapshot;
  usageError?: string;
}) {
  const groups = new Map<
    string,
    { workspace: WorkspaceTarget | undefined; runtimes: RuntimeSnapshot[] }
  >();
  for (const workspace of snapshot.workspaces)
    groups.set(workspace.id, { workspace, runtimes: [] });
  for (const runtime of snapshot.runtimes) {
    const workspace = workspaceForPath(runtime.cwd, snapshot.workspaces);
    const key = workspace?.id ?? 'other';
    groups.set(key, groups.get(key) ?? { workspace, runtimes: [] });
    groups.get(key)?.runtimes.push(runtime);
  }
  const orderedGroups = [...groups.entries()]
    .filter(([, group]) => group.runtimes.length > 0 || group.workspace?.active)
    .sort(([, a], [, b]) => {
      const active = (group: typeof a) =>
        group.runtimes.some(
          (runtime) => runtime.online !== false && runtime.liveState !== 'idle',
        );
      return Number(active(b)) - Number(active(a));
    });
  const liveCount = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false,
  ).length;
  return (
    <section>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Operational view</p>
          <h1>Agents</h1>
        </div>
        <span className="muted">
          {liveCount
            ? `${liveCount} live runtime${liveCount === 1 ? '' : 's'}`
            : 'No live runtimes'}{' '}
          · {snapshot.runtimes.length} tracked · {snapshot.sessions.length}{' '}
          sessions
        </span>
      </div>
      {liveCount === 0 && (
        <div className="empty-hero">
          <span className="empty-mark">›_</span>
          <div>
            <strong>
              {snapshot.runtimes.length
                ? 'No runtimes are connected.'
                : 'Nothing is running yet.'}
            </strong>
            <p>
              {snapshot.runtimes.length
                ? 'Offline and failed runtimes remain below for diagnosis.'
                : 'Start an agent to see its work here, or open a workspace through Sesh.'}
            </p>
          </div>
          <button type="button" onClick={() => navigate('/new')}>
            Start an agent
          </button>
        </div>
      )}
      {orderedGroups.map(([key, group]) => (
        <div
          className={`workspace-block ${group.runtimes.length ? '' : 'workspace-empty'}`}
          key={key}
        >
          <div className="workspace-title">
            <button
              type="button"
              onClick={() =>
                group.workspace && navigate(`/workspaces/${group.workspace.id}`)
              }
            >
              {group.workspace?.name ?? 'Other runtimes'}
            </button>
            <span>
              {group.runtimes.length
                ? `${group.runtimes.length} runtime${group.runtimes.length === 1 ? '' : 's'}`
                : group.workspace?.active
                  ? 'ready'
                  : 'dormant'}
            </span>
          </div>
          {group.runtimes.length ? (
            group.runtimes.map((runtime) => (
              <RuntimeCard key={runtime.runtimeId} runtime={runtime} />
            ))
          ) : (
            <p className="empty">
              {group.workspace?.active
                ? 'Ready for a new runtime.'
                : 'Open through Sesh to activate this workspace.'}
            </p>
          )}
        </div>
      ))}
      {groups.size === 0 && (
        <p className="empty">No Sesh workspaces discovered.</p>
      )}
      {snapshot.unread.length > 0 && (
        <NotificationList notifications={snapshot.unread} />
      )}
      <UsagePanel usage={snapshot.usage} error={usageError} />
      {snapshot.sessions.length > 0 && (
        <div className="recent-sessions">
          <div className="workspace-title">
            <span>Recent sessions</span>
            <span>across all workspaces</span>
          </div>
          {snapshot.sessions.slice(0, 8).map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </div>
      )}
    </section>
  );
}

function NotificationList({
  notifications,
}: {
  notifications: BrowserSnapshot['unread'];
}) {
  const [error, setError] = useState<string>();
  const [markingAll, setMarkingAll] = useState(false);
  const markRead = async (id: string) => {
    try {
      await api(`/api/notifications/${encodeURIComponent(id)}/read`, {
        method: 'POST',
        body: '{}',
      });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const markAllRead = async () => {
    setMarkingAll(true);
    try {
      await api('/api/notifications/read-all', {
        method: 'POST',
        body: '{}',
      });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMarkingAll(false);
    }
  };
  return (
    <section className="notifications" aria-labelledby="notifications-heading">
      <div className="workspace-title">
        <span id="notifications-heading">Unread events</span>
        <span className="notification-actions">
          <span>{notifications.length}</span>
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={markingAll}
          >
            {markingAll ? 'Reading…' : 'Read all'}
          </button>
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          Could not update notification: {error}
        </p>
      )}
      {notifications.slice(0, 8).map((notification) => (
        <article className="notification" key={notification.id}>
          <div>
            <strong>{notification.title}</strong>
            <p>{notification.body}</p>
          </div>
          <button type="button" onClick={() => void markRead(notification.id)}>
            Mark read
          </button>
        </article>
      ))}
    </section>
  );
}

function UsagePanel({ usage, error }: { usage: unknown; error?: string }) {
  const snapshots =
    usage &&
    typeof usage === 'object' &&
    Array.isArray((usage as Record<string, unknown>).snapshots)
      ? ((usage as Record<string, unknown>).snapshots as unknown[])
      : [];
  return (
    <section className="usage-panel" aria-labelledby="usage-heading">
      <div className="workspace-title">
        <span id="usage-heading">Usage</span>
        <span>{snapshots.length ? 'latest' : 'reported'}</span>
      </div>
      {error && (
        <p className="error" role="alert">
          Usage unavailable: {error}
        </p>
      )}
      {snapshots.length ? (
        snapshots.map((item, index) => {
          const record =
            item && typeof item === 'object'
              ? (item as Record<string, unknown>)
              : {};
          const primary =
            record.primary && typeof record.primary === 'object'
              ? (record.primary as Record<string, unknown>)
              : undefined;
          const used =
            typeof primary?.usedPercent === 'number'
              ? `${Math.round(primary.usedPercent)}% used`
              : 'window reported';
          return (
            <div className="usage-row" key={String(record.limitId ?? index)}>
              <strong>
                {String(record.limitName ?? record.limitId ?? 'limit')}
              </strong>
              <span>{used}</span>
            </div>
          );
        })
      ) : (
        <p className="muted">Usage data is unavailable.</p>
      )}
    </section>
  );
}

function RuntimeCard({ runtime }: { runtime: RuntimeSnapshot }) {
  const status = runtime.online === false ? 'offline' : runtime.liveState;
  const title = sessionDisplayTitle(runtime.session, runtime.session.entries);
  const glyph =
    status === 'working'
      ? '●'
      : status === 'waiting'
        ? '◆'
        : status === 'failed'
          ? '×'
          : status === 'offline'
            ? '○'
            : '·';
  const model = runtime.model
    ? `${runtime.model.provider}/${runtime.model.model}`
    : 'model unavailable';
  return (
    <button
      type="button"
      className={`runtime-card ${status}`}
      aria-label={`${title} ${status}`}
      onClick={() =>
        navigate(`/sessions/${encodeURIComponent(runtime.session.id)}`)
      }
    >
      <span className="runtime-rail">
        <span className="status-glyph">{glyph}</span>
      </span>
      <span className="runtime-main">
        <strong>{title}</strong>
        <span>
          <b>{status}</b> · {model}
        </span>
        <small>
          {runtime.lastError ?? `${runtime.cwd} · ${runtime.ownership}`}
        </small>
      </span>
      <span className="runtime-owner">
        {runtime.tmux?.displayTarget ?? 'session'}
      </span>
    </button>
  );
}

function WorkspaceView({
  id,
  snapshot,
}: {
  id: string;
  snapshot: BrowserSnapshot;
}) {
  const workspace = snapshot.workspaces.find((item) => item.id === id);
  const runtimes = snapshot.runtimes.filter(
    (runtime) =>
      workspace &&
      (runtime.cwd === workspace.canonicalPath ||
        runtime.cwd.startsWith(`${workspace.canonicalPath}/`)),
  );
  const sessions = snapshot.sessions.filter(
    (session) => session.workspaceId === id,
  );
  return (
    <section>
      <Back />
      <div className="section-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>{workspace?.name ?? 'Unknown workspace'}</h1>
          <p className="muted path">{workspace?.canonicalPath}</p>
        </div>
        <button type="button" onClick={() => navigate('/new')}>
          Start agent
        </button>
      </div>
      {workspace && !workspace.active && (
        <div className="notice">
          This workspace has no active tmux session yet. Open it through Sesh on
          the Mac first.
        </div>
      )}
      <h2>Active runtimes</h2>
      {runtimes.map((runtime) => (
        <RuntimeCard runtime={runtime} key={runtime.runtimeId} />
      ))}
      {!runtimes.length && <p className="empty">No active runtimes.</p>}
      <h2>Recent sessions</h2>
      {sessions.map((session) => (
        <SessionRow key={session.id} session={session} />
      ))}
    </section>
  );
}

function SessionRow({ session }: { session: SessionIndexEntry }) {
  return (
    <button
      type="button"
      className="session-row"
      onClick={() => navigate(`/sessions/${encodeURIComponent(session.id)}`)}
    >
      <span>
        <strong>{sessionDisplayTitle(session)}</strong>
        <small>{session.cwd}</small>
      </span>
      <span className="muted">
        {new Date(session.updatedAt).toLocaleDateString()}
      </span>
    </button>
  );
}
function Back() {
  return (
    <button type="button" className="back" onClick={() => navigate('/')}>
      ← Dashboard
    </button>
  );
}

export function isNearPageBottom(
  scrollHeight: number,
  scrollY: number,
  innerHeight: number,
  threshold = 120,
): boolean {
  return scrollHeight - scrollY - innerHeight <= threshold;
}

export function sessionNavigationTarget(
  currentSessionId: string,
  associatedRuntimeId: string | undefined,
  eventRuntimeId: string | undefined,
  event: DashboardEvent['event'],
): string | undefined {
  if (
    (event.type !== 'session.changed' && event.type !== 'session.snapshot') ||
    associatedRuntimeId === undefined ||
    eventRuntimeId !== associatedRuntimeId
  )
    return undefined;
  const nextSessionId = event.session.id;
  return nextSessionId !== currentSessionId ? nextSessionId : undefined;
}

function SessionView({
  id,
  snapshot,
  events,
  eventGeneration,
  reconnectNonce,
}: {
  id: string;
  snapshot: BrowserSnapshot;
  events: readonly DashboardEvent[];
  eventGeneration: { readonly current: number };
  reconnectNonce: number;
}) {
  const [data, setData] = useState<SessionResponse>();
  const [projection, setProjection] = useState<TranscriptProjection>();
  const [error, setError] = useState<string>();
  const scrolledSessionRef = useRef<string | undefined>(undefined);
  const stickToBottomRef = useRef(true);
  const sessionRequestRef = useRef(0);
  const runtimeIdRef = useRef<string | undefined>(undefined);
  const seenEventsRef = useRef(new WeakSet<DashboardEvent>());
  const runtime = snapshot.runtimes.find((item) => item.session.id === id);
  // During a runtime's session replacement the snapshot already points at the
  // new session, so there is briefly no runtime matching the old route. Keep
  // the prior association until the replacement event is consumed.
  if (runtime) runtimeIdRef.current = runtime.runtimeId;
  useEffect(() => {
    let active = true;
    // A reconnect gets a fresh session read even when no bridge event was lost.
    void reconnectNonce;
    const request = ++sessionRequestRef.current;
    void api<unknown>(`/api/sessions/${encodeURIComponent(id)}`)
      .then((value) => {
        const next = asSessionResponse(value);
        if (!next) throw new Error('Dashboard returned invalid session data.');
        if (active && request === sessionRequestRef.current) {
          if (next.metadata.id !== id) {
            navigate(`/sessions/${encodeURIComponent(next.metadata.id)}`);
            return;
          }
          setData(next);
          setProjection(hydrateTranscript(next.entries, next.metadata.id));
          setError(undefined);
        }
      })
      .catch(
        (cause) =>
          active &&
          request === sessionRequestRef.current &&
          setError(cause instanceof Error ? cause.message : String(cause)),
      );
    return () => {
      active = false;
    };
  }, [id, reconnectNonce]);
  useEffect(() => {
    void id;
    seenEventsRef.current = new WeakSet<DashboardEvent>();
    setData(undefined);
    setProjection(undefined);
  }, [id]);
  useEffect(() => {
    void id;
    stickToBottomRef.current = true;
    const update = () => {
      stickToBottomRef.current = isNearPageBottom(
        document.documentElement.scrollHeight,
        window.scrollY,
        window.innerHeight,
      );
    };
    window.addEventListener('scroll', update, { passive: true });
    update();
    return () => window.removeEventListener('scroll', update);
  }, [id]);
  useLayoutEffect(() => {
    if (!data || !projection) return;
    const enteringSession = scrolledSessionRef.current !== id;
    if (!enteringSession && !stickToBottomRef.current) return;
    scrolledSessionRef.current = id;
    const frame = window.requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return;
      window.scrollTo(0, document.documentElement.scrollHeight);
      stickToBottomRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data, projection, id]);
  useEffect(() => {
    for (const queued of events) {
      const event = queued.event;
      if (!event) continue;
      const changedSessionId =
        'sessionId' in event
          ? event.sessionId
          : 'session' in event
            ? event.session.id
            : undefined;
      const replacementSessionId = sessionNavigationTarget(
        id,
        runtimeIdRef.current,
        queued.runtimeId,
        event,
      );
      if (replacementSessionId) {
        navigate(`/sessions/${encodeURIComponent(replacementSessionId)}`);
        return;
      }
      if (
        (event.type === 'session.changed' ||
          event.type === 'session.snapshot') &&
        changedSessionId === id &&
        data
      ) {
        if (seenEventsRef.current.has(queued)) continue;
        seenEventsRef.current.add(queued);
        setData((current) =>
          current
            ? {
                ...current,
                metadata: {
                  ...current.metadata,
                  ...(event.session?.name !== undefined
                    ? { name: event.session.name }
                    : {}),
                  ...(event.session?.title !== undefined
                    ? { title: event.session.title }
                    : {}),
                },
              }
            : current,
        );
        continue;
      }
      if (!data || !projection || seenEventsRef.current.has(queued)) continue;
      if (event.type !== 'session.changed' && changedSessionId !== id) continue;
      seenEventsRef.current.add(queued);
      const captureBottomState = () => {
        stickToBottomRef.current = isNearPageBottom(
          document.documentElement.scrollHeight,
          window.scrollY,
          window.innerHeight,
        );
      };
      if (event.type === 'agent.settled') {
        captureBottomState();
        const request = ++sessionRequestRef.current;
        const arrivalGeneration = eventGeneration.current;
        void api<unknown>(`/api/sessions/${encodeURIComponent(id)}`)
          .then((value) => {
            const next = asSessionResponse(value);
            if (
              request === sessionRequestRef.current &&
              arrivalGeneration === eventGeneration.current &&
              next
            ) {
              setData(next);
              setProjection(hydrateTranscript(next.entries, next.metadata.id));
            }
          })
          .catch(() => undefined);
      } else if (
        event.type?.startsWith('message.') ||
        event.type?.startsWith('tool.')
      ) {
        // A later delta makes any settled-session read stale. Let the live
        // stream win instead of allowing a lagging file read to flash backward.
        sessionRequestRef.current += 1;
        captureBottomState();
        setProjection((current) =>
          current ? reduceTranscriptEvent(current, event) : current,
        );
      }
    }
  }, [events, data, eventGeneration, id, projection]);
  if (!data || !projection)
    return (
      <section>
        <Back />
        <p>{error ?? 'Loading session…'}</p>
      </section>
    );
  const runtimeError = runtime?.lastError;
  return (
    <section className="session-page">
      <Back />
      <div className="session-heading">
        <div>
          <p className="eyebrow">Session</p>
          <h1>{sessionDisplayTitle(data.metadata, data.entries)}</h1>
          <p className="muted">
            {data.metadata.cwd} ·{' '}
            {runtime
              ? runtime.online === false
                ? 'offline'
                : runtime.liveState
              : 'dormant'}
          </p>
        </div>
        <div className="session-heading-actions">
          <SessionRename
            id={id}
            initialName={data.metadata.name}
            onRenamed={(name) =>
              setData((current) =>
                current
                  ? { ...current, metadata: { ...current.metadata, name } }
                  : current,
              )
            }
          />
          {runtime && <RuntimeActions runtime={runtime} />}
        </div>
      </div>
      {runtimeError && (
        <div className="error notice" role="alert">
          Runtime failure: {runtimeError}
        </div>
      )}
      {runtime?.pendingInteractions.map((interaction) => (
        <InteractionCard key={interaction.id} interaction={interaction} />
      ))}
      <Transcript entries={selectLegacyTranscriptEntries(projection)} />
      <Composer runtime={runtime} sessionId={id} />
    </section>
  );
}

function SessionRename({
  id,
  initialName,
  onRenamed,
}: {
  id: string;
  initialName?: string;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => setName(initialName ?? ''), [initialName]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}/name`, {
        method: 'POST',
        body: JSON.stringify({ name: value }),
      });
      onRenamed(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="session-rename" onSubmit={(event) => void submit(event)}>
      <label htmlFor="session-name">Name</label>
      <input
        id="session-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Session name"
        maxLength={512}
        disabled={busy}
      />
      <button type="submit" disabled={busy || !name.trim()}>
        {busy ? 'Saving…' : 'Rename'}
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

function RuntimeActions({ runtime }: { runtime: RuntimeSnapshot }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || runtime.online === false;
  return (
    <div className="actions">
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          void run(() => postCommand(runtime.runtimeId, { type: 'abort' }))
        }
      >
        Abort
      </button>
      <button
        type="button"
        className="danger"
        disabled={disabled}
        onClick={() =>
          void run(() =>
            api(`/api/runtimes/${encodeURIComponent(runtime.runtimeId)}/stop`, {
              method: 'POST',
              body: '{}',
            }),
          )
        }
      >
        Stop
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function InteractionCard({
  interaction,
}: {
  interaction: RuntimeSnapshot['pendingInteractions'][number];
}) {
  const [answer, setAnswer] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (value: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await api(
        `/api/interactions/${encodeURIComponent(interaction.id)}/answer`,
        { method: 'POST', body: JSON.stringify({ answer: value }) },
      );
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api(
        `/api/interactions/${encodeURIComponent(interaction.id)}/cancel`,
        { method: 'POST', body: '{}' },
      );
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (sent)
    return (
      <div className="notice">
        Answered from this dashboard. The other Pi surface will close its
        question.
      </div>
    );
  return (
    <div
      className="interaction"
      role="dialog"
      aria-labelledby={`interaction-${interaction.id}`}
    >
      <p className="eyebrow">Waiting for input</p>
      <h2 id={`interaction-${interaction.id}`}>{interaction.question}</h2>
      {error && (
        <p className="error" role="alert">
          Interaction failed: {error}
        </p>
      )}
      <div className="choices">
        {interaction.choices
          .filter((choice) => !choice.custom)
          .map((choice) => (
            <button
              type="button"
              disabled={busy}
              key={choice.value}
              onClick={() => void submit(choice.value)}
            >
              {choice.label}
              <small>{choice.description}</small>
            </button>
          ))}
      </div>
      {interaction.allowCustom && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (answer.trim()) void submit(answer.trim());
          }}
        >
          <label className="sr-only" htmlFor={`answer-${interaction.id}`}>
            Answer
          </label>
          <input
            id={`answer-${interaction.id}`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={interaction.customLabel ?? 'Type an answer'}
          />
          <button disabled={busy} type="submit">
            Answer
          </button>
        </form>
      )}
      <button
        type="button"
        disabled={busy}
        className="link-button"
        onClick={() => void cancel()}
      >
        Cancel
      </button>
    </div>
  );
}

function activityTitleLine(text: string): string {
  return (
    text
      .split('\n')[0]
      ?.trim()
      .replace(/[.…:]+$/, '') ?? text
  );
}

export function shouldShowActivityLead(text: string, title: string): boolean {
  return !isNarration(text) && activityTitleLine(text) !== title;
}

function activityTitle(
  items: readonly TranscriptModelItem[],
  tools: readonly Extract<ActivityTranscriptEntry, { kind: 'tool' }>[],
  complete: boolean,
): string {
  const firstTool = items.findIndex((item) => item.entry.kind === 'tool');
  const preamble = items
    .slice(0, firstTool < 0 ? items.length : firstTool)
    .find(
      (item) =>
        item.role === 'assistant' && item.text && !isNarration(item.text),
    );
  if (preamble?.text) return activityTitleLine(preamble.text);
  const assistants = items
    .map((item) => item.raw)
    .filter((raw): raw is Record<string, unknown> =>
      Boolean(raw && typeof raw === 'object'),
    )
    .map(
      (raw) =>
        (raw.type === 'message' &&
        raw.message &&
        typeof raw.message === 'object'
          ? raw.message
          : raw) as Record<string, unknown>,
    )
    .filter((message) => Array.isArray(message.content));
  const textHeaders = assistants.flatMap((message) =>
    headersOf(message as never, 'text'),
  );
  const thinkingHeaders = assistants.flatMap((message) =>
    headersOf(message as never, 'thinking'),
  );
  return (
    (textHeaders.length > 0 ? textHeaders : thinkingHeaders).at(-1) ??
    describeTools(tools, undefined, complete)
  );
}

function Transcript({ entries }: { entries: unknown[] }) {
  const items = useMemo(() => toTranscriptEntries(entries), [entries]);
  const modelEntries = useMemo(() => items.map((item) => item.entry), [items]);
  const groups = useMemo(() => groupTranscript(modelEntries), [modelEntries]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groupByStart = new Map(groups.map((group) => [group.start, group]));
  return (
    <div className="transcript">
      <h2>Conversation &amp; activity</h2>
      {items.map((item, index) => {
        const group = groupByStart.get(index);
        if (group) {
          const groupKey = items[group.start]?.key ?? 'unknown-group';
          const expanded = open.has(groupKey);
          const tools = modelEntries
            .slice(group.start, group.end + 1)
            .filter(
              (
                entry,
              ): entry is Extract<ActivityTranscriptEntry, { kind: 'tool' }> =>
                entry.kind === 'tool',
            );
          const groupItems = items.slice(group.start, group.end + 1);
          const preparing = groupItems.some((item) => item.preparing);
          const complete =
            !preparing &&
            tools.length > 0 &&
            groupItems
              .filter((item) => item.entry.kind === 'tool')
              .every((item) => toolOutcome(item.raw) === 'success');
          const title = activityTitle(groupItems, tools, complete);
          const lead = items[group.start];
          const visibleLead =
            !lead?.preparing &&
            lead?.role === 'assistant' &&
            lead.text &&
            shouldShowActivityLead(lead.text, title)
              ? lead.text
              : undefined;
          const detailId = `activity-detail-${group.start}`;
          return (
            <div
              className={`activity-group ${complete ? 'activity-complete' : 'activity-pending'}`}
              key={`group-${groupKey}`}
            >
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={detailId}
                onClick={() =>
                  setOpen((current) => {
                    const next = new Set(current);
                    expanded ? next.delete(groupKey) : next.add(groupKey);
                    return next;
                  })
                }
              >
                <span className="activity-icon">{complete ? '✓' : '…'}</span>
                <strong>{title}</strong>
                <small>
                  {preparing
                    ? tools.length > 0
                      ? `${tools.length} tool${tools.length === 1 ? '' : 's'} · preparing next tool call`
                      : 'preparing tool call'
                    : `${tools.length} tool${tools.length === 1 ? '' : 's'} · ${expanded ? 'hide detail' : 'show detail'}`}
                </small>
              </button>
              {visibleLead && (
                <div className="activity-lead">
                  <span className="message-role">assistant</span>
                  <Markdown>{visibleLead}</Markdown>
                </div>
              )}
              {expanded && (
                <div className="activity-detail" id={detailId}>
                  {groupItems.map((child) => (
                    <TranscriptEntry key={child.key} item={child} />
                  ))}
                </div>
              )}
            </div>
          );
        }
        if (
          groups.some(
            (candidate) => index > candidate.start && index <= candidate.end,
          )
        )
          return null;
        return <TranscriptEntry key={item.key} item={item} />;
      })}
    </div>
  );
}

function TranscriptEntry({
  item,
}: {
  item: import('./transcript').TranscriptModelItem;
}) {
  if (item.preparing)
    return (
      <div className="transcript-entry preparing-toolcall" role="status">
        <span className="activity-icon">…</span>
        <strong>
          {item.text ? activityTitleLine(item.text) : 'Preparing tool call'}
        </strong>
        <small>preparing tool call</small>
      </div>
    );
  if (item.role && (item.text || item.imageCount))
    return (
      <article className={`message-bubble message-${item.role}`}>
        <span className="message-role">{item.role}</span>
        {item.imageCount ? (
          <span className="message-attachment">
            {item.imageCount} image{item.imageCount === 1 ? '' : 's'} attached
          </span>
        ) : null}
        {item.text ? <Markdown>{item.text}</Markdown> : null}
      </article>
    );
  const raw = item.raw;
  const tool = toolRecordForTranscript(raw);
  if (tool) {
    const name =
      typeof tool.name === 'string'
        ? tool.name
        : typeof tool.toolName === 'string'
          ? tool.toolName
          : 'tool';
    return (
      <details className="transcript-entry tool-detail">
        <summary>
          <span className="tool-chip">{name}</span>
          <span>{toolSummary(tool)}</span>
        </summary>
        <pre>{JSON.stringify(raw, null, 2)}</pre>
      </details>
    );
  }
  const text = JSON.stringify(raw, null, 2);
  return (
    <details className="transcript-entry">
      <summary>
        {typeof raw === 'object' && raw && 'type' in raw
          ? String((raw as { type?: unknown }).type)
          : 'entry'}
      </summary>
      <pre>{text}</pre>
    </details>
  );
}

async function postCommand(
  runtimeId: string,
  command: Record<string, unknown>,
): Promise<void> {
  await api(`/api/runtimes/${encodeURIComponent(runtimeId)}/command`, {
    method: 'POST',
    body: JSON.stringify(command),
  });
}

async function postCommandWithImages(
  runtimeId: string,
  command: Record<string, unknown>,
  images: readonly File[],
): Promise<void> {
  const body = new FormData();
  body.append('command', JSON.stringify(command));
  for (const image of images) body.append('images', image, image.name);
  await multipartApi(
    `/api/runtimes/${encodeURIComponent(runtimeId)}/command`,
    body,
  );
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_SIZE = 12 * 1024 * 1024;

type ImageAttachment = { file: File; previewUrl: string };

export function runtimeSupportsImages(runtime: RuntimeSnapshot): boolean {
  return runtime.model?.supportsImages === true;
}

export function addImageAttachments(
  existing: readonly File[],
  incoming: readonly File[],
): { accepted: File[]; error?: string } {
  const accepted: File[] = [];
  let totalSize = existing.reduce((total, file) => total + file.size, 0);
  let error: string | undefined;
  for (const file of incoming) {
    if (file.size === 0) {
      error ??= `${file.name} is empty.`;
      continue;
    }
    if (!IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number])) {
      error ??= `${file.name} is not a PNG, JPEG, or WebP image.`;
      continue;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      error ??= `${file.name} is larger than the 5 MiB image limit.`;
      continue;
    }
    if (existing.length + accepted.length >= MAX_IMAGE_ATTACHMENTS) {
      error ??= `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`;
      continue;
    }
    if (totalSize + file.size > MAX_IMAGE_TOTAL_SIZE) {
      error ??= 'Attached images exceed the 12 MiB total limit.';
      continue;
    }
    accepted.push(file);
    totalSize += file.size;
  }
  return { accepted, ...(error ? { error } : {}) };
}

function Composer({
  runtime,
}: {
  runtime: RuntimeSnapshot | undefined;
  sessionId: string;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'prompt' | 'steer' | 'followUp'>('prompt');
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentsRef = useRef<ImageAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const disabled =
    !runtime ||
    runtime.online === false ||
    runtime.liveState === 'stopping' ||
    runtime.liveState === 'waiting';
  const attachmentsEnabled = runtime ? runtimeSupportsImages(runtime) : false;
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current)
        URL.revokeObjectURL(attachment.previewUrl);
    },
    [],
  );
  useEffect(() => {
    setMode(runtime?.liveState === 'working' ? 'followUp' : 'prompt');
  }, [runtime?.liveState]);
  useEffect(() => {
    if (attachmentsEnabled) return;
    setAttachments((current) => {
      for (const attachment of current)
        URL.revokeObjectURL(attachment.previewUrl);
      return [];
    });
  }, [attachmentsEnabled]);
  if (!runtime)
    return (
      <div className="composer disabled">
        <p>This session is dormant.</p>
        <button type="button" onClick={() => navigate('/new')}>
          Resume in a new runtime
        </button>
      </div>
    );
  if (runtime.online === false)
    return (
      <div className="composer disabled">
        <p>Runtime offline; controls are unavailable.</p>
        <button
          type="button"
          onClick={() =>
            navigate(`/runtimes/${encodeURIComponent(runtime.runtimeId)}`)
          }
        >
          View diagnostics
        </button>
      </div>
    );
  const selectImages = (files: readonly File[]) => {
    if (!attachmentsEnabled || disabled || busy) return;
    const result = addImageAttachments(
      attachments.map((attachment) => attachment.file),
      files,
    );
    if (result.accepted.length) {
      setAttachments((current) => [
        ...current,
        ...result.accepted.map((file) => ({
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      ]);
    }
    setError(result.error);
  };
  const removeImage = (previewUrl: string) => {
    const attachment = attachments.find(
      (candidate) => candidate.previewUrl === previewUrl,
    );
    if (!attachment) return;
    URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) =>
      current.filter((candidate) => candidate.previewUrl !== previewUrl),
    );
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedText = text.trim();
    if ((!trimmedText && !attachments.length) || disabled || busy) return;
    if (attachments.length > 0 && !attachmentsEnabled) {
      setError('The selected model does not support image input.');
      return;
    }
    setBusy(true);
    setError(undefined);
    const command = {
      type: runtime.liveState === 'idle' ? 'prompt' : mode,
      text: trimmedText,
    };
    try {
      if (attachments.length)
        await postCommandWithImages(
          runtime.runtimeId,
          command,
          attachments.map((attachment) => attachment.file),
        );
      else await postCommand(runtime.runtimeId, command);
      for (const attachment of attachments)
        URL.revokeObjectURL(attachment.previewUrl);
      setAttachments([]);
      setText('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={`composer ${dragging ? 'dragging' : ''}`}
      onSubmit={(event) => void submit(event)}
      onDragEnter={(event) => {
        if (!attachmentsEnabled || disabled || busy) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!attachmentsEnabled || disabled || busy) return;
        event.preventDefault();
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!attachmentsEnabled || disabled || busy) return;
        event.preventDefault();
        setDragging(false);
        selectImages(Array.from(event.dataTransfer.files));
      }}
      aria-label="Send a message"
    >
      <div className="composer-mode">
        {runtime.liveState === 'working' && (
          <>
            <span>Mode:</span>
            <button
              type="button"
              aria-pressed={mode === 'followUp'}
              className={mode === 'followUp' ? 'selected' : ''}
              onClick={() => setMode('followUp')}
            >
              Follow-up
            </button>
            <button
              type="button"
              aria-pressed={mode === 'steer'}
              className={mode === 'steer' ? 'selected' : ''}
              onClick={() => setMode('steer')}
            >
              Steer
            </button>
          </>
        )}
        {runtime.liveState === 'idle' && <span>Prompt</span>}
        {runtime.liveState === 'waiting' && <span>Answer above</span>}
        <ContextIndicator usage={runtime.contextUsage} />
        <span className="shortcut">⌘↵ send · shift+↵ newline</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {attachmentsEnabled ? (
        <>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept={IMAGE_TYPES.join(',')}
            multiple
            aria-label="Choose images"
            disabled={disabled || busy}
            onChange={(event) => {
              selectImages(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          {attachments.length > 0 && (
            <fieldset className="composer-previews">
              <legend className="sr-only">Image attachments</legend>
              {attachments.map((attachment) => (
                <div className="composer-preview" key={attachment.previewUrl}>
                  <img src={attachment.previewUrl} alt={attachment.file.name} />
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.file.name}`}
                    disabled={busy}
                    onClick={() => removeImage(attachment.previewUrl)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </fieldset>
          )}
          <button
            type="button"
            className="composer-attach"
            disabled={disabled || busy}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach images"
          >
            + Image
          </button>
        </>
      ) : (
        <button
          type="button"
          className="composer-attach"
          disabled
          title="The selected model does not support image input."
          aria-label="Attach images (unsupported by selected model)"
        >
          + Image
        </button>
      )}
      <textarea
        aria-label="Message Pi"
        value={text}
        disabled={disabled || busy}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          if (!attachmentsEnabled || disabled || busy) return;
          const files = Array.from(event.clipboardData.files);
          const itemFiles = Array.from(event.clipboardData.items).flatMap(
            (item) => {
              const file = item.kind === 'file' ? item.getAsFile() : null;
              return file ? [file] : [];
            },
          );
          const images = files.length ? files : itemFiles;
          if (!images.length) return;
          event.preventDefault();
          selectImages(images);
        }}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={disabled ? 'Agent is waiting for input' : 'Message Pi…'}
        rows={3}
      />
      <button
        type="submit"
        disabled={disabled || busy || (!text.trim() && !attachments.length)}
      >
        Send
      </button>
    </form>
  );
}

function RuntimeView({
  id,
  snapshot,
}: {
  id: string;
  snapshot: BrowserSnapshot;
}) {
  const runtime = snapshot.runtimes.find((item) => item.runtimeId === id);
  return (
    <section>
      <Back />
      <h1>Runtime diagnostics</h1>
      {runtime ? (
        <div className="diagnostics">
          <p>
            Ownership: <strong>{runtime.ownership}</strong>
          </p>
          <p>PID: {runtime.pid}</p>
          <p>Bridge: {runtime.online === false ? 'offline' : 'connected'}</p>
          <p>Session: {runtime.session.id}</p>
          <p>tmux: {runtime.tmux?.displayTarget ?? 'not reported'}</p>
          <button
            type="button"
            onClick={() =>
              navigate(`/sessions/${encodeURIComponent(runtime.session.id)}`)
            }
          >
            Open session
          </button>
          <pre>{JSON.stringify(runtime, null, 2)}</pre>
        </div>
      ) : (
        <p>Unknown runtime.</p>
      )}
    </section>
  );
}

function LaunchView({ snapshot }: { snapshot: BrowserSnapshot }) {
  const [workspaceId, setWorkspaceId] = useState(
    snapshot.workspaces.find((item) => item.active)?.id ?? '',
  );
  const [sessionId, setSessionId] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const sessions = snapshot.sessions.filter(
    (session) => session.workspaceId === workspaceId,
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const request: StartRuntimeRequest = {
      workspaceId,
      ...(sessionId ? { sessionId } : {}),
      ...(name ? { name } : {}),
      ...(prompt ? { initialPrompt: prompt } : {}),
      acknowledgeSharedWorkingDirectory: ack,
    };
    try {
      const result = await api<{ runtimeId: string }>('/api/runtimes/start', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      navigate(`/runtimes/${result.runtimeId}`);
    } catch (cause) {
      const appError = cause as AppError;
      setError(appError.message);
      if (appError.code === 'shared-working-directory') setAck(false);
    }
  };
  return (
    <section>
      <Back />
      <p className="eyebrow">New runtime</p>
      <h1>Start an agent</h1>
      <form className="launch-form" onSubmit={(event) => void submit(event)}>
        <label>
          Workspace
          <select
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              setSessionId('');
            }}
          >
            {snapshot.workspaces.map((workspace) => (
              <option value={workspace.id} key={workspace.id}>
                {workspace.name}
                {workspace.active ? '' : ' (dormant)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Resume session (optional)
          <select
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
          >
            <option value="">New session</option>
            {sessions.map((session) => (
              <option value={session.id} key={session.id}>
                {sessionDisplayTitle(session)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Optional session name"
          />
        </label>
        <label>
          Initial prompt
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
          />
        </label>
        {error && <div className="error">{error}</div>}
        {error.includes('Both agents') && (
          <label className="check">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />{' '}
            I understand this shared-working-directory warning and want to start
            anyway.
          </label>
        )}
        <button type="submit" disabled={!workspaceId}>
          Start in a new tmux window
        </button>
      </form>
    </section>
  );
}
