import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { Back, useDashboardNavigate } from '../routes/navigation';
import { RuntimeCard } from './dashboard-overview';
import { SessionRow } from './workspace-session';

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
          <h1>{workspace?.name ?? 'Unknown workspace'}</h1>
          <p className="muted path">{workspace?.canonicalPath}</p>
        </div>
        <button
          type="button"
          onClick={() => go(`/workspaces/${encodeURIComponent(id)}/new`)}
        >
          New chat
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
