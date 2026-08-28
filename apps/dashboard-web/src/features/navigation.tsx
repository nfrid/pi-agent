import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useRouterState } from '@tanstack/react-router';
import {
  newProjectThreadPath,
  useDashboardNavigate,
} from '../routes/navigation';
import { CommandPaletteTrigger } from './command-palette';

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
        <CommandPaletteTrigger disabled={paletteDisabled} />
      </div>
    </header>
  );
}
