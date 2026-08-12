import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { Back, useDashboardNavigate } from './dashboard';

export function RuntimeView({
  id,
  snapshot,
}: {
  id: string;
  snapshot: BrowserSnapshot;
}) {
  const go = useDashboardNavigate();
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
              go(`/sessions/${encodeURIComponent(runtime.session.id)}`)
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
