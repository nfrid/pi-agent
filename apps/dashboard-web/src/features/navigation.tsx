import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useRouterState } from '@tanstack/react-router';
import { newChatPath, useDashboardNavigate } from '../routes/navigation';
import { CommandPalette } from './command-palette';
import { useDashboardUtility } from './dashboard-utility-context';

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
  const utility = useDashboardUtility();
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
    : pathname.startsWith('/threads/')
      ? snapshot.runs?.find(
          (run) =>
            run.threadId === decodeURIComponent(pathname.split('/')[2] ?? '') &&
            run.piSessionId,
        )?.piSessionId
      : undefined;
  const hasProjects = (snapshot.projects?.length ?? 0) > 0;
  const managedActive = (snapshot.runs ?? []).filter(
    (run) =>
      run.status !== 'queued' &&
      ['preparing', 'starting', 'running'].includes(run.status),
  ).length;
  const managedAttention = (snapshot.threads ?? []).filter((thread) => {
    const latest = (snapshot.runs ?? [])
      .filter((run) => run.threadId === thread.id)
      .sort((a, b) => b.attempt - a.attempt || b.createdAt - a.createdAt)[0];
    return (
      thread.status === 'needs-input' ||
      thread.status === 'failed' ||
      latest?.status === 'waiting' ||
      latest?.status === 'failed'
    );
  }).length;
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
        {hasProjects && (
          <>
            <button
              type="button"
              className="header-management-link"
              onClick={() => go('/')}
            >
              Projects <b>{managedAttention}</b>
            </button>
            <span className="header-management-count">
              {managedActive} active ·{' '}
              {
                (snapshot.runs ?? []).filter((run) => run.status === 'queued')
                  .length
              }{' '}
              queued
            </span>
          </>
        )}
        {showGlobalNew && (
          <button
            type="button"
            className="global-new-agent"
            aria-label={hasProjects ? 'New thread' : 'New chat'}
            onClick={() => {
              if (hasProjects) {
                const projectMatch = pathname.match(
                  /^\/projects\/([^/]+)(?:\/|$)/u,
                );
                const threadMatch = pathname.match(
                  /^\/threads\/([^/]+)(?:\/|$)/u,
                );
                const threadProjectId = threadMatch?.[1]
                  ? snapshot.threads?.find(
                      (thread) =>
                        thread.id === decodeURIComponent(threadMatch[1]),
                    )?.projectId
                  : undefined;
                const projectId = projectMatch?.[1]
                  ? decodeURIComponent(projectMatch[1])
                  : threadMatch
                    ? threadProjectId
                    : snapshot.projects?.[0]?.id;
                if (projectId)
                  go(`/projects/${encodeURIComponent(projectId)}/new`);
                return;
              }
              const workspaceMatch = pathname.match(/^\/workspaces\/([^/]+)$/u);
              go(
                newChatPath(
                  snapshot,
                  workspaceMatch?.[1]
                    ? decodeURIComponent(workspaceMatch[1])
                    : undefined,
                ),
              );
            }}
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
