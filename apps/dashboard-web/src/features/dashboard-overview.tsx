import {
  type DashboardLiveStore,
  dashboardHttpClient,
  workspaceRefreshMutationOptions,
} from '@pi-dashboard/client';
import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { workspaceForPath } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { sessionDisplayTitle } from '../app-helpers';
import { useDashboardNavigate } from '../routes/navigation';
import { CommandPalette } from './command-palette';
import { NotificationList, PushButton, UsagePanel } from './notifications';
import { SessionRow } from './workspace-session';

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
        <CommandPalette snapshot={snapshot} />
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

function WorkspaceRefresh({
  snapshot,
  store,
}: {
  snapshot: BrowserSnapshot;
  store?: DashboardLiveStore;
}) {
  const mutation = useMutation(
    workspaceRefreshMutationOptions(dashboardHttpClient),
  );
  const refresh = async () => {
    try {
      const result = (await mutation.mutateAsync()) as {
        workspaces?: BrowserSnapshot['workspaces'];
      };
      if (store && result.workspaces) {
        store.installSnapshot(
          { ...snapshot, workspaces: result.workspaces },
          { source: 'http', requestGeneration: store.getGeneration() },
        );
      }
    } catch {
      // The live catalogue remains usable; the button exposes failure state.
    }
  };
  return (
    <button
      type="button"
      className="header-action"
      onClick={() => void refresh()}
      disabled={mutation.isPending}
      aria-label="Refresh workspaces"
    >
      {mutation.isPending ? 'Refreshing…' : 'Refresh workspaces'}
    </button>
  );
}

export function Dashboard({
  snapshot,
  usageError,
  store,
}: {
  snapshot: BrowserSnapshot;
  usageError?: string;
  store?: DashboardLiveStore;
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
        <div className="section-heading-actions">
          <span className="muted">
            {liveCount
              ? `${liveCount} live runtime${liveCount === 1 ? '' : 's'}`
              : 'No live runtimes'}{' '}
            · {snapshot.runtimes.length} tracked · {snapshot.sessions.length}{' '}
            sessions
          </span>
          <WorkspaceRefresh snapshot={snapshot} store={store} />
        </div>
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

export function RuntimeCard({ runtime }: { runtime: RuntimeSnapshot }) {
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
