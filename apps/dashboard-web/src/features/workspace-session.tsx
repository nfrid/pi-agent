import type { SessionIndexEntry } from '@pi-dashboard/protocol';
import { sessionDisplayTitle } from '../app-helpers';
import { useDashboardNavigate } from '../routes/navigation';

export function SessionRow({ session }: { session: SessionIndexEntry }) {
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
