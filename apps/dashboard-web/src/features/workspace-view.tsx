import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { Back, useDashboardNavigate } from '../routes/navigation';
import { RuntimeCard } from './dashboard-overview';
import { SessionRow } from './workspace-session';
import styles from './workspace-view.module.css';
import {
  sortWorkspaceRuntimes,
  sortWorkspaceSessions,
  summarizeWorkspace,
} from './workspace-view-model';

export {
  sortWorkspaceRuntimes,
  sortWorkspaceSessions,
  summarizeWorkspace,
} from './workspace-view-model';

function sessionCountLabel(count: number): string {
  return `${count} session${count === 1 ? '' : 's'}`;
}

function runtimeCountLabel(count: number): string {
  return `${count} runtime${count === 1 ? '' : 's'}`;
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
  const runtimes = sortWorkspaceRuntimes(
    snapshot.runtimes.filter(
      (runtime) =>
        workspace &&
        (runtime.cwd === workspace.canonicalPath ||
          runtime.cwd.startsWith(`${workspace.canonicalPath}/`)),
    ),
  );
  const sessions = sortWorkspaceSessions(
    snapshot.sessions.filter((session) => session.workspaceId === id),
  );
  const summary = summarizeWorkspace(workspace, runtimes, sessions);

  return (
    <section className={styles.workspaceView}>
      <Back />
      <div className={`section-heading ${styles.heading}`}>
        <div>
          <h1>{workspace?.name ?? 'Unknown workspace'}</h1>
          {workspace?.canonicalPath && (
            <p className="muted path">{workspace.canonicalPath}</p>
          )}
        </div>
        {workspace && (
          <button
            type="button"
            onClick={() => go(`/workspaces/${encodeURIComponent(id)}/new`)}
          >
            New chat
          </button>
        )}
      </div>

      <section className={styles.summary} aria-label="Workspace summary">
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Readiness</span>
          <strong
            className={`${styles.summaryValue} ${styles[summary.readiness]}`}
          >
            {summary.readiness}
          </strong>
          <span className={styles.summaryMeta}>
            {!workspace
              ? 'Workspace unavailable'
              : workspace.active
                ? 'Sesh workspace is active'
                : 'Not active in Sesh'}
          </span>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Live runtimes</span>
          <strong className={styles.summaryValue}>
            {summary.liveRuntimeCount}
          </strong>
          <span className={styles.summaryMeta}>
            {summary.runtimeCount === summary.liveRuntimeCount
              ? runtimeCountLabel(summary.runtimeCount)
              : `${runtimeCountLabel(summary.runtimeCount)} · ${summary.runtimeCount - summary.liveRuntimeCount} offline`}
          </span>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Recent sessions</span>
          <strong className={styles.summaryValue}>
            {summary.sessionCount}
          </strong>
          <span className={styles.summaryMeta}>
            {summary.latestSession
              ? `Latest ${new Date(summary.latestSession.updatedAt).toLocaleDateString()}`
              : 'No sessions yet'}
          </span>
        </div>
      </section>

      {workspace && !workspace.active && (
        <div className={`notice ${styles.dormantNotice}`} role="status">
          This workspace is dormant. Open it through Sesh on the Mac before
          starting a chat.
        </div>
      )}
      {!workspace && (
        <p className={styles.emptyState} role="status">
          This workspace is no longer in the current catalogue.
        </p>
      )}

      <div className={styles.listHeading}>
        <h2>Runtimes</h2>
        <span className={styles.listCount}>
          {runtimeCountLabel(runtimes.length)}
        </span>
      </div>
      <div className={styles.list}>
        {runtimes.map((runtime) => (
          <RuntimeCard runtime={runtime} key={runtime.runtimeId} />
        ))}
        {!runtimes.length && (
          <p className={styles.emptyState}>
            <strong>No live runtimes</strong>
            {workspace?.active
              ? 'Start a chat to connect a runtime to this workspace.'
              : 'A runtime will appear here after the Sesh workspace is active.'}
          </p>
        )}
      </div>

      <div className={styles.listHeading}>
        <h2>Recent sessions</h2>
        <span className={styles.listCount}>
          {sessionCountLabel(sessions.length)}
        </span>
      </div>
      <div className={styles.list}>
        {sessions.map((session) => (
          <SessionRow key={session.id} session={session} />
        ))}
        {!sessions.length && (
          <p className={styles.emptyState}>
            <strong>No sessions yet</strong>
            {workspace
              ? 'Start a chat to create the first session for this workspace.'
              : 'Sessions for this workspace are not available.'}
          </p>
        )}
      </div>
    </section>
  );
}
