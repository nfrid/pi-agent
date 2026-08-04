import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { workspaceForPath } from '@pi-dashboard/protocol';
import { useNavigate } from '@tanstack/react-router';
import { sessionDisplayTitle } from '../app-helpers';
import {
  NotificationList,
  PushButton,
  UsagePanel,
} from '../features/notifications';

function useDashboardNavigate(): (path: string) => void {
  const navigate = useNavigate();
  return (path) => void navigate({ to: path });
}

export function Header({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
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
          onClick={() => go('/')}
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
          onClick={() => go('/new')}
        >
          + Agent
        </button>
      </div>
    </header>
  );
}

export function Dashboard({
  snapshot,
  usageError,
}: {
  snapshot: BrowserSnapshot;
  usageError?: string;
}) {
  const go = useDashboardNavigate();
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
          <button type="button" onClick={() => go('/new')}>
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
                group.workspace && go(`/workspaces/${group.workspace.id}`)
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

function RuntimeCard({ runtime }: { runtime: RuntimeSnapshot }) {
  const go = useDashboardNavigate();
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
      onClick={() => go(`/sessions/${encodeURIComponent(runtime.session.id)}`)}
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

export function WorkspaceView({
  id,
  snapshot,
}: {
  id: string;
  snapshot: BrowserSnapshot;
}) {
  const go = useDashboardNavigate();
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
        <button type="button" onClick={() => go('/new')}>
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
  const go = useDashboardNavigate();
  return (
    <button
      type="button"
      className="session-row"
      onClick={() => go(`/sessions/${encodeURIComponent(session.id)}`)}
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
export function Back() {
  const go = useDashboardNavigate();
  return (
    <button type="button" className="back" onClick={() => go('/')}>
      ← Dashboard
    </button>
  );
}
