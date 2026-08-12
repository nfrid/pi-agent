import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { workspaceForPath } from '@pi-dashboard/protocol';
import { type TouchEvent, useEffect, useMemo, useRef, useState } from 'react';
import { sessionDisplayTitle } from '../app-helpers';
import { useDashboardNavigate } from '../routes/navigation';
import { useDashboardUtility } from './dashboard-utility-context';
import { useOverlayPresence } from './overlay-presence';
import { DashboardTime } from './timestamp';

export type AgentThreadRow = {
  id: string;
  title: string;
  workspaceId?: string;
  workspaceName: string;
  cwd: string;
  status: RuntimeSnapshot['liveState'] | 'offline' | 'dormant';
  runtime?: RuntimeSnapshot;
  session?: SessionIndexEntry;
  startedAt: number;
  updatedAt: number;
};

function dormantRank(status: AgentThreadRow['status']): number {
  return status === 'dormant' ? 1 : 0;
}

export function agentThreadRows(snapshot: BrowserSnapshot): AgentThreadRow[] {
  const workspaces = snapshot.workspaces;
  const sessionsById = new Map(
    snapshot.sessions.map((session) => [session.id, session]),
  );
  const rows = new Map<string, AgentThreadRow>();
  for (const runtime of snapshot.runtimes) {
    const session = sessionsById.get(runtime.session.id);
    const workspace = workspaceForPath(runtime.cwd, workspaces);
    const status = runtime.online === false ? 'offline' : runtime.liveState;
    rows.set(runtime.session.id, {
      id: runtime.session.id,
      title: sessionDisplayTitle(runtime.session, runtime.session.entries),
      workspaceId: session?.workspaceId ?? workspace?.id,
      workspaceName: workspace?.name ?? 'Other workspace',
      cwd: runtime.cwd,
      status,
      runtime,
      session,
      startedAt: session?.startedAt ?? 0,
      updatedAt: session?.updatedAt ?? 0,
    });
  }
  for (const session of snapshot.sessions) {
    if (rows.has(session.id)) continue;
    const workspace = workspaces.find(
      (item) => item.id === session.workspaceId,
    );
    rows.set(session.id, {
      id: session.id,
      title: sessionDisplayTitle(session),
      workspaceId: session.workspaceId,
      workspaceName: workspace?.name ?? 'Other workspace',
      cwd: session.cwd,
      status: 'dormant',
      session,
      startedAt: session.startedAt ?? 0,
      updatedAt: session.updatedAt,
    });
  }
  return [...rows.values()].sort(
    (left, right) =>
      dormantRank(left.status) - dormantRank(right.status) ||
      right.startedAt - left.startedAt ||
      left.title.localeCompare(right.title),
  );
}

function statusGlyph(status: AgentThreadRow['status']): string {
  if (status === 'working') return '●';
  if (status === 'compacting') return '◐';
  if (status === 'waiting') return '◆';
  if (status === 'failed') return '!';
  if (status === 'offline') return '○';
  if (status === 'dormant') return '◌';
  return '●';
}

function statusLabel(status: AgentThreadRow['status']): string {
  return status;
}

const MAX_VISIBLE_ACTIVE_THREADS = 40;
const MAX_VISIBLE_HISTORY_THREADS = 24;

function isHistoricalThread(row: AgentThreadRow): boolean {
  return row.status === 'idle' || row.status === 'dormant';
}

export function boundedAgentThreadRows(
  rows: readonly AgentThreadRow[],
  historyLimit = MAX_VISIBLE_HISTORY_THREADS,
): AgentThreadRow[] {
  const active = rows.filter((row) => !isHistoricalThread(row));
  const history = rows.filter(isHistoricalThread);
  return [
    ...active.slice(0, MAX_VISIBLE_ACTIVE_THREADS),
    ...history.slice(0, Math.max(0, historyLimit)),
  ];
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

export function AgentThreadNav({
  snapshot,
  mode = 'home',
  currentSessionId,
  open = false,
  onOpenChange,
}: {
  snapshot: BrowserSnapshot;
  mode?: 'home' | 'session';
  currentSessionId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const go = useDashboardNavigate();
  const utility = useDashboardUtility();
  const [query, setQuery] = useState('');
  const [historyLimit, setHistoryLimit] = useState(MAX_VISIBLE_HISTORY_THREADS);
  const touchStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const edgeTouchStart = useRef<{ x: number; y: number } | undefined>(
    undefined,
  );
  const drawerRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 820px)').matches,
  );
  const { present: drawerPresent, exiting: drawerExiting } = useOverlayPresence(
    mode === 'session' && open,
  );
  useEffect(() => {
    if (mode !== 'session') return;
    const media = window.matchMedia('(max-width: 820px)');
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [mode]);
  const rows = useMemo(() => agentThreadRows(snapshot), [snapshot]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? rows.filter((row) =>
          `${row.title} ${row.workspaceName} ${row.cwd} ${row.status}`
            .toLowerCase()
            .includes(needle),
        )
      : rows;
  }, [query, rows]);
  const visibleRows = useMemo(
    () => boundedAgentThreadRows(filtered, historyLimit),
    [filtered, historyLimit],
  );
  const hiddenRowCount = Math.max(
    0,
    filtered.filter(isHistoricalThread).length -
      visibleRows.filter(isHistoricalThread).length,
  );
  const groups = useMemo(() => {
    const result = new Map<
      string,
      { workspaceId?: string; workspaceName: string; rows: AgentThreadRow[] }
    >();
    for (const row of visibleRows) {
      const key = row.workspaceId ?? `other:${row.workspaceName}`;
      const group =
        result.get(key) ??
        ({
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          rows: [],
        } satisfies {
          workspaceId?: string;
          workspaceName: string;
          rows: AgentThreadRow[];
        });
      group.rows.push(row);
      result.set(key, group);
    }
    return [...result.entries()];
  }, [visibleRows]);
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touchStart.current;
    const touch = event.changedTouches[0];
    touchStart.current = undefined;
    if (!start || !touch || mode !== 'session') return;
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    if (start.x < 32 && dx > 52 && dx > dy * 1.25) onOpenChange?.(true);
    if (open && dx < -52 && Math.abs(dx) > dy * 1.25) onOpenChange?.(false);
  };
  useEffect(() => {
    if (mode !== 'session') return;
    const onStart = (event: globalThis.TouchEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-swipe-dismiss="right"]')
      )
        return;
      const touch = event.changedTouches[0];
      if (touch && touch.clientX < 32) {
        event.preventDefault();
        edgeTouchStart.current = { x: touch.clientX, y: touch.clientY };
      }
    };
    const onEnd = (event: globalThis.TouchEvent) => {
      const start = edgeTouchStart.current;
      const touch = event.changedTouches[0];
      edgeTouchStart.current = undefined;
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (dx > 52 && dx > dy * 1.25) onOpenChange?.(true);
      else if (open && dx < -52 && Math.abs(dx) > dy * 1.25)
        onOpenChange?.(false);
    };
    window.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [mode, onOpenChange, open]);
  useEffect(() => {
    if (mode !== 'session' || !open) return;
    const mobile = window.matchMedia('(max-width: 820px)').matches;
    const frame = mobile
      ? window.requestAnimationFrame(() => {
          const first = drawerRef.current?.querySelector<HTMLElement>(
            'input, button:not(:disabled), [href]',
          );
          first?.focus();
        })
      : undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange?.(false);
        return;
      }
      if (!mobile || event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'input, button:not(:disabled), [href]',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      if (mobile && !document.querySelector('.interaction-dock'))
        handleRef.current?.focus({ preventScroll: true });
    };
  }, [mode, onOpenChange, open]);
  const select = (id: string) => {
    go(`/sessions/${encodeURIComponent(id)}`);
    if (mode === 'session') onOpenChange?.(false);
  };
  const openUtility = (
    panel: 'workspaces' | 'sessions' | 'inbox',
    fallbackPath: string,
  ) => {
    onOpenChange?.(false);
    if (utility) utility.openPanel(panel);
    else go(fallbackPath);
  };
  const nav = (
    <aside
      ref={mode === 'session' ? drawerRef : undefined}
      className={`agent-thread-nav agent-thread-nav-${mode}`}
      aria-label="Agents and threads"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="agent-nav-header">
        <div>
          <p className="eyebrow">Workspace threads</p>
          <strong>Agents</strong>
        </div>
      </div>
      <label className="agent-nav-search">
        <span className="sr-only">Search agents and threads</span>
        <span aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHistoryLimit(MAX_VISIBLE_HISTORY_THREADS);
          }}
          placeholder="Search threads"
          type="search"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear thread search"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        )}
      </label>
      <div className="agent-nav-list">
        {!groups.length && (
          <p className="agent-nav-empty">No matching threads.</p>
        )}
        {groups.map(([key, group]) => (
          <section className="agent-workspace-group" key={key}>
            <div className="agent-workspace-heading">
              <button
                type="button"
                disabled={!group.workspaceId}
                onClick={() => {
                  const workspaceId = group.workspaceId;
                  if (!workspaceId) return;
                  go(`/workspaces/${encodeURIComponent(workspaceId)}`);
                  if (mode === 'session') onOpenChange?.(false);
                }}
              >
                {group.workspaceName}
              </button>
              <span className="agent-workspace-heading-actions">
                <small>{group.rows.length}</small>
                {group.workspaceId && (
                  <button
                    type="button"
                    className="agent-workspace-new"
                    aria-label={`New chat in ${group.workspaceName}`}
                    onClick={() => {
                      go(
                        `/workspaces/${encodeURIComponent(group.workspaceId as string)}/new`,
                      );
                      if (mode === 'session') onOpenChange?.(false);
                    }}
                  >
                    +
                  </button>
                )}
              </span>
            </div>
            {group.rows.map((row) => {
              const selected = row.id === currentSessionId;
              return (
                <button
                  type="button"
                  className={`agent-thread-row ${selected ? 'selected' : ''} status-${row.status}`}
                  aria-current={selected ? 'page' : undefined}
                  aria-label={`${row.title} ${statusLabel(row.status)}`}
                  key={row.id}
                  onClick={() => select(row.id)}
                >
                  <span className="agent-thread-glyph" aria-hidden="true">
                    {statusGlyph(row.status)}
                  </span>
                  <span className="agent-thread-copy">
                    <strong>{row.title}</strong>
                    <small>
                      <span className="agent-thread-context">
                        <span>{statusLabel(row.status)}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{shortPath(row.cwd)}</span>
                      </span>
                      <DashboardTime
                        className="agent-thread-time"
                        timestamp={row.updatedAt}
                        context="sidebar"
                      />
                    </small>
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      {hiddenRowCount > 0 && (
        <button
          type="button"
          className="agent-nav-more"
          onClick={() =>
            setHistoryLimit((current) => current + MAX_VISIBLE_HISTORY_THREADS)
          }
        >
          Show next {Math.min(hiddenRowCount, MAX_VISIBLE_HISTORY_THREADS)}{' '}
          older thread
          {Math.min(hiddenRowCount, MAX_VISIBLE_HISTORY_THREADS) === 1
            ? ''
            : 's'}
        </button>
      )}
      <footer className="agent-nav-footer">
        <button
          type="button"
          className="agent-nav-utility"
          onClick={() => openUtility('workspaces', '/workspaces')}
        >
          <span aria-hidden="true">⌂</span>
          <span>Workspaces</span>
        </button>
        <button
          type="button"
          className="agent-nav-utility"
          onClick={() => openUtility('sessions', '/sessions')}
        >
          <span aria-hidden="true">▤</span>
          <span>History</span>
        </button>
        <button
          type="button"
          className="agent-nav-utility"
          onClick={() => openUtility('inbox', '/inbox')}
        >
          <span aria-hidden="true">✉</span>
          <span>Inbox</span>
          {snapshot.unread.length > 0 && (
            <b>
              {snapshot.unread.length > 99 ? '99+' : snapshot.unread.length}
            </b>
          )}
        </button>
      </footer>
    </aside>
  );
  if (mode === 'home') return nav;
  return (
    <>
      <button
        ref={handleRef}
        type="button"
        className="agent-nav-handle"
        aria-label="Open agent list"
        onClick={() => onOpenChange?.(true)}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        ‹
      </button>
      {drawerPresent && (
        <button
          type="button"
          className={`agent-nav-backdrop${drawerExiting ? ' is-exiting' : ''}`}
          aria-label="Close agent list"
          onClick={() => onOpenChange?.(false)}
        />
      )}
      {(!isMobile || drawerPresent) && (
        <div
          className={`agent-nav-drawer ${open ? 'open' : ''}${drawerExiting ? ' is-exiting' : ''}`}
          aria-hidden={isMobile && !open ? true : undefined}
        >
          {nav}
        </div>
      )}
    </>
  );
}

export function workspaceNameForSession(
  snapshot: BrowserSnapshot,
  session: SessionIndexEntry,
  runtime?: RuntimeSnapshot,
): string {
  const workspace =
    snapshot.workspaces.find(
      (item: WorkspaceTarget) => item.id === session.workspaceId,
    ) ?? workspaceForPath(runtime?.cwd ?? session.cwd, snapshot.workspaces);
  return workspace?.name ?? 'Other workspace';
}
