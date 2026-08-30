import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useState } from 'react';
import { sessionDisplayTitle } from '../app-helpers';
import {
  newProjectThreadPath,
  useDashboardNavigate,
} from '../routes/navigation';
import { AgentThreadNav, agentThreadRows } from './agent-thread-nav';
import styles from './dashboard-overview.module.css';
import { runtimePauseStatus } from './extension-surfaces';

/** Home is intentionally a thread browser, not a dashboard of duplicate cards. */
export function Dashboard({ snapshot }: { snapshot: BrowserSnapshot }) {
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
    <div
      className={`session-layout dashboard-workspace ${styles.dashboardWorkspace}`}
    >
      <AgentThreadNav
        snapshot={snapshot}
        mode="session"
        open={agentNavOpen}
        onOpenChange={setAgentNavOpen}
      />
      <section
        className={`dashboard-empty-workspace ${styles.dashboardEmptyWorkspace}`}
        aria-label="Agent workspace"
      >
        <div className={`empty-workspace-state ${styles.emptyWorkspaceState}`}>
          <span className="empty-mark" aria-hidden="true">
            ›_
          </span>
          <h1>Pick a thread to continue</h1>
          <p>Select an existing thread or create a new one to get started.</p>
          <div
            className={`empty-workspace-actions ${styles.emptyWorkspaceActions}`}
          >
            <button
              type="button"
              onClick={() => go(newProjectThreadPath(snapshot))}
            >
              New thread
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
          </div>
        </div>
        {snapshot.runtimes.length > 0 && onlineCount === 0 && (
          <div className="notice quiet-notice" role="status">
            No runtimes are connected. Offline and failed threads remain in the
            project nav for diagnosis.
          </div>
        )}
      </section>
    </div>
  );
}

export function RuntimeCard({
  runtime,
}: {
  runtime: import('@pi-dashboard/protocol').RuntimeSnapshot;
}) {
  const go = useDashboardNavigate();
  const pauseStatus = runtimePauseStatus(runtime);
  const status =
    runtime.online === false
      ? 'offline'
      : pauseStatus
        ? 'paused'
        : runtime.liveState;
  const statusLabel = pauseStatus?.label ?? status;
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
          <b>{statusLabel}</b> · {model}
        </span>
        <small>
          {runtime.lastError ?? `${runtime.cwd} · ${runtime.ownership}`}
        </small>
      </span>
      <span className="runtime-owner">
        {runtime.ownership === 'managed' ? 'headless host' : 'bridge'}
      </span>
    </button>
  );
}
