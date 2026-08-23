import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useRouterState } from '@tanstack/react-router';
import {
  newProjectThreadPath,
  useDashboardNavigate,
} from '../routes/navigation';
import { CommandPalette } from './command-palette';
import { UsageCapsule } from './usage-indicator';

export function runtimeStatusCounts(snapshot: BrowserSnapshot) {
  return {
    working: snapshot.runtimes.filter(
      (runtime) =>
        runtime.online !== false &&
        (runtime.liveState === 'working' || runtime.liveState === 'compacting'),
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
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const showGlobalNew =
    pathname !== '/' &&
    !pathname.startsWith('/sessions/') &&
    !pathname.endsWith('/new') &&
    !pathname.includes('/new/pending/');
  const activeSessionId = pathname.startsWith('/sessions/')
    ? decodeURIComponent(pathname.split('/')[2] ?? '')
    : undefined;
  const paletteDisabled = false;
  return (
    <header className="navigation-shell">
      <div className="global-tools">
        {showGlobalNew && (
          <button
            type="button"
            className="global-new-agent"
            aria-label="New chat"
            onClick={() => {
              const projectMatch = pathname.match(/^\/projects\/([^/]+)$/u);
              go(
                newProjectThreadPath(
                  snapshot,
                  projectMatch?.[1]
                    ? decodeURIComponent(projectMatch[1])
                    : undefined,
                ),
              );
            }}
          >
            +
          </button>
        )}
        {!activeSessionId && (
          <UsageCapsule usage={snapshot.usage} variant="toolbar" />
        )}
        <CommandPalette snapshot={snapshot} disabled={paletteDisabled} />
      </div>
    </header>
  );
}
