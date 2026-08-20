import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useEffect, useMemo, useState } from 'react';
import { useDashboardNavigate } from '../routes/navigation';
import {
  type AgentThreadRow,
  agentThreadRows,
  boundedAgentThreadRows,
  filterAgentThreadRows,
  groupAgentThreadRows,
  hiddenAgentThreadRowCount,
  MAX_VISIBLE_HISTORY_THREADS,
  shortPath,
  statusGlyph,
  statusLabel,
} from './agent-thread-nav/model';
import {
  isThreadUnread,
  useAgentThreadUnread,
} from './agent-thread-nav/unread';
import {
  type AgentThreadNavMode,
  useAgentThreadDrawer,
} from './agent-thread-nav/use-agent-thread-drawer';
import styles from './agent-thread-nav.module.css';
import { useDashboardUtility } from './dashboard-utility-context';
import {
  RuntimeLifecycleActions,
  type RuntimeLifecycleThreadProps,
} from './runtime-actions';
import { AgentNavDrawerShell } from './surface-drawer';
import { DashboardTime } from './timestamp';
import { UsageCapsule } from './usage-indicator';

export type { AgentThreadRow } from './agent-thread-nav/model';
export {
  agentThreadRows,
  boundedAgentThreadRows,
  workspaceNameForSession,
} from './agent-thread-nav/model';

const COLLAPSED_WORKSPACES_KEY = 'pi-dashboard-collapsed-workspaces-v1';

type CollapsedWorkspaces = Record<string, boolean>;

function readCollapsedWorkspaces(): CollapsedWorkspaces {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSED_WORKSPACES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] =>
          typeof entry[0] === 'string' && entry[1] === true,
      ),
    );
  } catch {
    return {};
  }
}

function writeCollapsedWorkspaces(state: CollapsedWorkspaces): void {
  try {
    globalThis.localStorage?.setItem(
      COLLAPSED_WORKSPACES_KEY,
      JSON.stringify(state),
    );
  } catch {
    // Storage can be unavailable in private browsing; expansion remains local.
  }
}

function ThreadActions({
  row,
  unread,
  copied,
  onMarkUnread,
  onCopyPath,
}: {
  row: AgentThreadRow;
  unread: boolean;
  copied: boolean;
  onMarkUnread: () => void;
  onCopyPath: () => void;
}) {
  return (
    <span className={styles.threadActions}>
      <button
        type="button"
        aria-label={
          unread
            ? `Thread ${row.title} is unread`
            : `Mark ${row.title} as unread`
        }
        title={unread ? 'Unread' : 'Mark unread'}
        className={styles.threadAction}
        onPointerDownCapture={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (!unread) onMarkUnread();
        }}
      >
        <span aria-hidden="true">●</span>
      </button>
      <button
        type="button"
        aria-label={`Copy path for ${row.title}`}
        title={copied ? 'Copied path' : 'Copy path'}
        className={styles.threadAction}
        onPointerDownCapture={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onCopyPath();
        }}
      >
        <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      </button>
    </span>
  );
}

function AgentThreadLink({
  row,
  selected,
  unread,
  onSelect,
  lifecycleProps,
}: {
  row: AgentThreadRow;
  selected: boolean;
  unread: boolean;
  onSelect: () => void;
  lifecycleProps?: RuntimeLifecycleThreadProps;
}) {
  return (
    <button
      {...lifecycleProps}
      type="button"
      className={styles.threadLink}
      aria-current={selected ? 'page' : undefined}
      aria-label={`${row.title} ${statusLabel(row)}${unread ? ' unread' : ''}`}
      onClick={onSelect}
    >
      <span
        className={`agent-thread-glyph ${styles.threadGlyph}`}
        aria-hidden="true"
      >
        {statusGlyph(row.status)}
      </span>
      <span className={`agent-thread-copy ${styles.threadCopy}`}>
        <strong>{row.title}</strong>
        <small>
          <span className={styles.threadContext}>
            <span>{statusLabel(row)}</span>
            <span aria-hidden="true"> · </span>
            <span>{shortPath(row.cwd)}</span>
          </span>
          <DashboardTime
            className={`agent-thread-time ${styles.threadTime}`}
            timestamp={row.updatedAt}
            context="sidebar"
          />
        </small>
      </span>
    </button>
  );
}

export function AgentThreadNav({
  snapshot,
  mode = 'home',
  currentSessionId,
  open = false,
  onOpenChange,
}: {
  snapshot: BrowserSnapshot;
  mode?: AgentThreadNavMode;
  currentSessionId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const go = useDashboardNavigate();
  const utility = useDashboardUtility();
  const [query, setQuery] = useState('');
  const [historyLimit, setHistoryLimit] = useState(MAX_VISIBLE_HISTORY_THREADS);
  const [collapsedWorkspaces, setCollapsedWorkspaces] =
    useState<CollapsedWorkspaces>(readCollapsedWorkspaces);
  const [copiedPath, setCopiedPath] = useState<string>();
  const {
    state: unreadState,
    visitCurrent,
    markUnread,
  } = useAgentThreadUnread(currentSessionId);
  const {
    drawerRef,
    handleRef,
    drawerPresent,
    drawerExiting,
    isMobile,
    onTouchStart,
    onTouchEnd,
  } = useAgentThreadDrawer({ mode, open, onOpenChange });
  const rows = useMemo(() => agentThreadRows(snapshot), [snapshot]);
  const filtered = useMemo(
    () => filterAgentThreadRows(rows, query),
    [query, rows],
  );
  const visibleRows = useMemo(
    () => boundedAgentThreadRows(filtered, historyLimit, currentSessionId),
    [currentSessionId, filtered, historyLimit],
  );
  const hiddenRowCount = hiddenAgentThreadRowCount(filtered, visibleRows);
  const groups = useMemo(
    () => groupAgentThreadRows(visibleRows),
    [visibleRows],
  );
  useEffect(() => {
    visitCurrent(rows);
  }, [rows, visitCurrent]);
  const toggleWorkspace = (key: string) => {
    setCollapsedWorkspaces((current) => {
      const next = { ...current, [key]: !current[key] };
      if (!next[key]) delete next[key];
      writeCollapsedWorkspaces(next);
      return next;
    });
  };
  const copyPath = async (row: AgentThreadRow) => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(row.cwd);
      else {
        const input = document.createElement('textarea');
        input.value = row.cwd;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.append(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      setCopiedPath(row.id);
      window.setTimeout(() => setCopiedPath(undefined), 1200);
    } catch {
      // Clipboard permissions are optional; navigation should remain usable.
    }
  };
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
      className={`agent-thread-nav agent-thread-nav-${mode} ${styles.threadNav}`}
      aria-label="Agents and threads"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className={styles.header}>
        <div>
          <p className="eyebrow">Workspace threads</p>
          <strong>Agents</strong>
        </div>
      </div>
      <label className={styles.search}>
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
      <div className={styles.list}>
        {!groups.length && <p className={styles.empty}>No matching threads.</p>}
        {groups.map(([key, group]) => {
          const collapsed = collapsedWorkspaces[key] === true;
          const expanded =
            !collapsed ||
            Boolean(query.trim()) ||
            group.rows.some((row) => row.id === currentSessionId);
          const groupId = `agent-thread-group-${encodeURIComponent(key)}`;
          return (
            <section className={styles.workspaceGroup} key={key}>
              <div className={styles.workspaceHeading}>
                <span className={styles.workspaceHeadingTitle}>
                  <button
                    type="button"
                    className={styles.workspaceToggle}
                    aria-expanded={expanded}
                    aria-controls={groupId}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.workspaceName}`}
                    onClick={() => toggleWorkspace(key)}
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.workspaceLink}
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
                </span>
                <span className={styles.workspaceHeadingActions}>
                  <small>{group.rows.length}</small>
                  {group.workspaceId && (
                    <button
                      type="button"
                      className={styles.workspaceNew}
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
              {expanded && (
                <div id={groupId}>
                  {group.rows.map((row) => {
                    const selected = row.id === currentSessionId;
                    const unread = isThreadUnread(row, unreadState);
                    const rowClassName = `agent-thread-row ${styles.threadRow} ${selected ? 'selected' : ''} ${unread ? 'unread' : ''} status-${row.status}`;
                    const rowActions = (
                      <ThreadActions
                        row={row}
                        unread={unread}
                        copied={copiedPath === row.id}
                        onMarkUnread={() => markUnread(row.id)}
                        onCopyPath={() => void copyPath(row)}
                      />
                    );
                    const renderThreadLink = (
                      lifecycleProps?: RuntimeLifecycleThreadProps,
                    ) => (
                      <AgentThreadLink
                        row={row}
                        selected={selected}
                        unread={unread}
                        onSelect={() => select(row.id)}
                        lifecycleProps={lifecycleProps}
                      />
                    );

                    if (!row.runtime) {
                      return (
                        <div className={rowClassName} key={row.id}>
                          {renderThreadLink()}
                          {rowActions}
                        </div>
                      );
                    }
                    return (
                      <RuntimeLifecycleActions
                        key={row.id}
                        runtime={row.runtime}
                        title={row.title}
                        rowClassName={rowClassName}
                        rowActions={rowActions}
                      >
                        {renderThreadLink}
                      </RuntimeLifecycleActions>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {hiddenRowCount > 0 && (
        <button
          type="button"
          className={styles.more}
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
      {mode === 'session' && (
        <div className={styles.usageRow}>
          <UsageCapsule usage={snapshot.usage} variant="sidebar" />
        </div>
      )}
      <footer
        className={`${styles.footer} ${mode === 'session' ? styles.sessionFooter : ''}`}
      >
        <button
          type="button"
          className={styles.utility}
          onClick={() => openUtility('workspaces', '/workspaces')}
        >
          <span aria-hidden="true">⌂</span>
          <span>Workspaces</span>
        </button>
        <button
          type="button"
          className={styles.utility}
          onClick={() => openUtility('sessions', '/sessions')}
        >
          <span aria-hidden="true">▤</span>
          <span>History</span>
        </button>
        <button
          type="button"
          className={styles.utility}
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
    <AgentNavDrawerShell
      open={open}
      onOpenChange={onOpenChange}
      isMobile={isMobile}
      drawerPresent={drawerPresent}
      drawerExiting={drawerExiting}
      handleRef={handleRef}
      drawerClassName={styles.drawer}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {nav}
    </AgentNavDrawerShell>
  );
}
