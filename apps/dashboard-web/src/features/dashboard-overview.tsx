import {
  type DashboardLiveStore,
  dashboardHttpClient,
  workspaceRefreshMutationOptions,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { workspaceForPath } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { sessionDisplayTitle } from '../app-helpers';
import { newChatPath, useDashboardNavigate } from '../routes/navigation';
import { AgentThreadNav, agentThreadRows } from './agent-thread-nav';
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

/** Home is intentionally a thread browser, not a dashboard of duplicate cards. */
export function Dashboard({
  snapshot,
  store,
}: {
  snapshot: BrowserSnapshot;
  usageError?: string;
  store?: DashboardLiveStore;
}) {
  const go = useDashboardNavigate();
  const [agentNavOpen, setAgentNavOpen] = useState(false);
  const latestSession = snapshot.sessions.reduce<
    BrowserSnapshot['sessions'][number] | undefined
  >(
    (latest, session) =>
      !latest || session.updatedAt > latest.updatedAt ? session : latest,
    undefined,
  );
  const latestId = latestSession?.id ?? agentThreadRows(snapshot)[0]?.id;
  const onlineCount = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false,
  ).length;
  return (
    <div className="session-layout dashboard-workspace">
      <AgentThreadNav
        snapshot={snapshot}
        mode="session"
        open={agentNavOpen}
        onOpenChange={setAgentNavOpen}
      />
      <section
        className="dashboard-empty-workspace"
        aria-label="Agent workspace"
      >
        <div className="home-heading">
          <div>
            <p className="eyebrow">Pi workspace</p>
            <h1>No thread selected</h1>
            <p className="muted">
              Choose an agent thread from the workspace nav to resume its
              transcript.
            </p>
          </div>
        </div>
        <div className="empty-workspace-state">
          <span className="empty-mark" aria-hidden="true">
            ›_
          </span>
          <strong>Ready for the next task</strong>
          <p>
            Start a new agent, or choose an existing thread from the workspace
            nav to open its transcript.
          </p>
          <div className="empty-workspace-actions">
            <button type="button" onClick={() => go(newChatPath(snapshot))}>
              New chat
            </button>
            {latestId && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => go(`/sessions/${encodeURIComponent(latestId)}`)}
              >
                Resume latest
              </button>
            )}
            <WorkspaceRefresh snapshot={snapshot} store={store} />
          </div>
        </div>
        {snapshot.runtimes.length > 0 && onlineCount === 0 && (
          <div className="notice quiet-notice" role="status">
            No runtimes are connected. Offline and failed threads remain in the
            workspace nav for diagnosis.
          </div>
        )}
      </section>
    </div>
  );
}

export function WorkspacesView({
  snapshot,
  store,
}: {
  snapshot: BrowserSnapshot;
  store?: DashboardLiveStore;
}) {
  const go = useDashboardNavigate();
  return (
    <section>
      <div className="section-heading page-heading">
        <div>
          <h1>Workspaces</h1>
          <p className="muted">Projects available to agents and sessions.</p>
        </div>
        <WorkspaceRefresh snapshot={snapshot} store={store} />
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

export function RuntimeCard({
  runtime,
}: {
  runtime: import('@pi-dashboard/protocol').RuntimeSnapshot;
}) {
  const go = useDashboardNavigate();
  const status = runtime.online === false ? 'offline' : runtime.liveState;
  const title = sessionDisplayTitle(runtime.session, runtime.session.entries);
  const glyph =
    status === 'working'
      ? '●'
      : status === 'compacting'
        ? '◐'
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
