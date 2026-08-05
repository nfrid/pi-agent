import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useRouterState } from '@tanstack/react-router';
import { useDashboardNavigate } from '../routes/navigation';
import { CommandPalette } from './command-palette';
import { useDashboardUtility } from './dashboard-utility-context';

export function runtimeStatusCounts(snapshot: BrowserSnapshot) {
  return {
    working: snapshot.runtimes.filter(
      (runtime) => runtime.online !== false && runtime.liveState === 'working',
    ).length,
    waiting: snapshot.runtimes.filter(
      (runtime) => runtime.online !== false && runtime.liveState === 'waiting',
    ).length,
    failed: snapshot.runtimes.filter(
      (runtime) => runtime.online !== false && runtime.liveState === 'failed',
    ).length,
    offline: snapshot.runtimes.filter((runtime) => runtime.online === false)
      .length,
  };
}

/** Contextual agent/thread navigation replaces the old permanent destination rail. */
export function Header({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  const utility = useDashboardUtility();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const showGlobalNew = pathname !== '/' && !pathname.startsWith('/sessions/');
  const activeSessionId = pathname.startsWith('/sessions/')
    ? decodeURIComponent(pathname.split('/')[2] ?? '')
    : undefined;
  const paletteDisabled = Boolean(
    activeSessionId &&
      snapshot.runtimes.some(
        (runtime) =>
          runtime.session?.id === activeSessionId &&
          runtime.pendingInteractions.length > 0,
      ),
  );
  return (
    <header className="navigation-shell">
      <div className="global-tools">
        {showGlobalNew && (
          <button
            type="button"
            className="global-new-agent"
            aria-label="New agent"
            onClick={() => go('/new')}
          >
            +
          </button>
        )}
        <button
          type="button"
          className="global-notifications"
          aria-label={`Open notifications${snapshot.unread.length ? ` (${snapshot.unread.length} unread)` : ''}`}
          onClick={() => {
            if (utility) utility.openPanel('inbox');
            else go('/inbox');
          }}
        >
          <span aria-hidden="true">✉</span>
          {snapshot.unread.length > 0 && (
            <b>
              {snapshot.unread.length > 99 ? '99+' : snapshot.unread.length}
            </b>
          )}
        </button>
        <CommandPalette snapshot={snapshot} disabled={paletteDisabled} />
      </div>
    </header>
  );
}
