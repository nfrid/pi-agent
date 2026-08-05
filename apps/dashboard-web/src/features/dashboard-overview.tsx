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
import { SessionRow } from './workspace-session';

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
      className="secondary-button"
      onClick={() => void refresh()}
      disabled={mutation.isPending}
      aria-label="Refresh workspaces"
    >
      {mutation.isPending ? 'Refreshing…' : 'Refresh'}
    </button>
  );
}

export function Dashboard({
  snapshot,
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
  for (const runtime of snapshot.runtimes) {
    const workspace = workspaceForPath(runtime.cwd, snapshot.workspaces);
    const key = workspace?.id ?? 'other';
    groups.set(key, groups.get(key) ?? { workspace, runtimes: [] });
    groups.get(key)?.runtimes.push(runtime);
  }
  const orderedGroups = [...groups.entries()].sort(([, a], [, b]) => {
    const active = (group: typeof a) =>
      group.runtimes.some(
        (runtime) => runtime.online !== false && runtime.liveState !== 'idle',
      );
    return Number(active(b)) - Number(active(a));
  });
  const onlineCount = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false,
  ).length;
  return (
    <section>
      <div className="section-heading page-heading">
        <div>
          <h1>Agents</h1>
          <p className="muted">Actionable runtimes across your workspaces.</p>
        </div>
        <div className="section-heading-actions">
          <WorkspaceRefresh snapshot={snapshot} store={store} />
          <button type="button" onClick={() => go('/new')}>
            + New agent
          </button>
        </div>
      </div>
      {!snapshot.runtimes.length && (
        <div className="empty-hero">
          <span className="empty-mark">›_</span>
          <div>
            <strong>No runtimes are tracked yet.</strong>
            <p>Start an agent to see its work here.</p>
          </div>
          <button type="button" onClick={() => go('/new')}>
            Start an agent
          </button>
        </div>
      )}
      {snapshot.runtimes.length > 0 && onlineCount === 0 && (
        <div className="notice quiet-notice" role="status">
          No runtimes are connected. Offline and failed runtimes remain below
          for diagnosis.
        </div>
      )}
      {orderedGroups.map(([key, group]) => (
        <div className="workspace-block" key={key}>
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
              {group.runtimes.length} runtime
              {group.runtimes.length === 1 ? '' : 's'}
            </span>
          </div>
          {group.runtimes.map((runtime) => (
            <RuntimeCard key={runtime.runtimeId} runtime={runtime} />
          ))}
        </div>
      ))}
    </section>
  );
}

export function WorkspacesView({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  return (
    <section>
      <div className="section-heading page-heading">
        <div>
          <h1>Workspaces</h1>
          <p className="muted">Projects available to agents and sessions.</p>
        </div>
        <WorkspaceRefresh snapshot={snapshot} />
      </div>
      <div className="workspace-list">
        {snapshot.workspaces.map((workspace) => {
          const runtimes = snapshot.runtimes.filter(
            (runtime) =>
              workspaceForPath(runtime.cwd, [workspace])?.id === workspace.id,
          );
          const sessions = snapshot.sessions.filter(
            (session) => session.workspaceId === workspace.id,
          );
          return (
            <button
              type="button"
              className="workspace-card"
              key={workspace.id}
              onClick={() => go(`/workspaces/${workspace.id}`)}
            >
              <span className="workspace-card-main">
                <strong>{workspace.name}</strong>
                <small className="path">{workspace.canonicalPath}</small>
              </span>
              <span
                className={`workspace-state ${workspace.active ? 'active' : ''}`}
              >
                <i aria-hidden="true">●</i>{' '}
                {workspace.active ? 'ready' : 'dormant'}
              </span>
              <span className="workspace-card-meta">
                {runtimes.length} runtime{runtimes.length === 1 ? '' : 's'} ·{' '}
                {sessions.length} session{sessions.length === 1 ? '' : 's'}
              </span>
            </button>
          );
        })}
      </div>
      {!snapshot.workspaces.length && (
        <p className="empty">No Sesh workspaces discovered.</p>
      )}
    </section>
  );
}

export function SessionsView({ snapshot }: { snapshot: BrowserSnapshot }) {
  return (
    <section>
      <div className="section-heading page-heading">
        <div>
          <h1>Sessions</h1>
          <p className="muted">History across every workspace.</p>
        </div>
      </div>
      <div className="session-list">
        {snapshot.sessions.map((session) => (
          <SessionRow key={session.id} session={session} />
        ))}
      </div>
      {!snapshot.sessions.length && <p className="empty">No sessions yet.</p>}
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
