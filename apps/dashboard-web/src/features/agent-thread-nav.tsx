import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useDashboardNavigate } from '../routes/navigation';
import {
  type AgentThreadRow,
  agentThreadRows,
  boundedAgentThreadRows,
  filterAgentThreadRows,
  groupAgentThreadRows,
  hiddenAgentThreadRowCount,
  historyRowsForShelf,
  isHistoryThread,
  MAX_VISIBLE_HISTORY_THREADS,
  searchAgentThreadRows,
  shortPath,
  statusGlyph,
  statusLabel,
  workspaceGroupIsExpanded,
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
  AgentThreadActionMenu,
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
const COLLAPSED_HISTORY_KEY = 'pi-dashboard-collapsed-history-v1';

type CollapsedWorkspaces = Record<string, boolean>;

type CollapsedHistory = Record<string, boolean>;

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

function readCollapsedHistory(): CollapsedHistory {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSED_HISTORY_KEY);
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

function writeCollapsedHistory(state: CollapsedHistory): void {
  try {
    globalThis.localStorage?.setItem(
      COLLAPSED_HISTORY_KEY,
      JSON.stringify(state),
    );
  } catch {
    // Storage can be unavailable in private browsing; expansion remains local.
  }
}

// Per-row actions are rendered in the shared accessible context menu below.
function AgentThreadLink({
  row,
  selected,
  unread,
  activeResult,
  onSelect,
  lifecycleProps,
}: {
  row: AgentThreadRow;
  selected: boolean;
  unread: boolean;
  activeResult: boolean;
  onSelect: () => void;
  lifecycleProps?: RuntimeLifecycleThreadProps;
}) {
  return (
    <button
      {...lifecycleProps}
      type="button"
      className={styles.threadLink}
      aria-current={selected ? 'page' : undefined}
      data-search-active={activeResult ? '' : undefined}
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
  const [collapsedHistory, setCollapsedHistory] =
    useState<CollapsedHistory>(readCollapsedHistory);
  const [activeResultId, setActiveResultId] = useState<string>();
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
    () =>
      query.trim()
        ? searchAgentThreadRows(filtered)
        : boundedAgentThreadRows(filtered, historyLimit, currentSessionId),
    [currentSessionId, filtered, historyLimit, query],
  );
  const hiddenRowCount = hiddenAgentThreadRowCount(filtered, visibleRows);
  const groups = useMemo(
    () => groupAgentThreadRows(visibleRows),
    [visibleRows],
  );
  const searchResultRows = query.trim() ? visibleRows : [];
  useEffect(() => {
    if (
      activeResultId &&
      !searchResultRows.some((row) => row.id === activeResultId)
    )
      setActiveResultId(undefined);
  }, [activeResultId, searchResultRows]);
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
  const toggleHistory = (key: string) => {
    setCollapsedHistory((current) => {
      const next = { ...current, [key]: !current[key] };
      if (!next[key]) delete next[key];
      writeCollapsedHistory(next);
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
      return;
    } catch {
      // Clipboard permissions are optional; navigation should remain usable.
    }
  };
  const select = (id: string) => {
    go(`/sessions/${encodeURIComponent(id)}`);
    if (mode === 'session') onOpenChange?.(false);
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('');
      setActiveResultId(undefined);
      return;
    }
    if (!query.trim() || !searchResultRows.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const currentIndex = activeResultId
        ? searchResultRows.findIndex((row) => row.id === activeResultId)
        : -1;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex =
        currentIndex < 0
          ? direction === 1
            ? 0
            : searchResultRows.length - 1
          : (currentIndex + direction + searchResultRows.length) %
            searchResultRows.length;
      setActiveResultId(searchResultRows[nextIndex]?.id);
      return;
    }
    if (event.key === 'Enter' && activeResultId) {
      event.preventDefault();
      select(activeResultId);
    }
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
            setActiveResultId(undefined);
            setHistoryLimit(MAX_VISIBLE_HISTORY_THREADS);
          }}
          onKeyDown={onSearchKeyDown}
          placeholder="Search threads"
          type="search"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear thread search"
            onClick={() => {
              setQuery('');
              setActiveResultId(undefined);
            }}
          >
            ×
          </button>
        )}
      </label>
      <div className={styles.list}>
        {!groups.length && <p className={styles.empty}>No matching threads.</p>}
        {groups.map(([key, group]) => {
          const collapsed = collapsedWorkspaces[key] === true;
          const searching = Boolean(query.trim());
          const expanded = workspaceGroupIsExpanded(collapsed, searching);
          const activeRows = group.rows.filter((row) => !isHistoryThread(row));
          const historyRows = group.rows.filter(isHistoryThread);
          const historyExpanded = !collapsedHistory[key] || searching;
          const visibleHistoryRows = historyRowsForShelf(
            historyRows,
            historyExpanded,
            currentSessionId,
          );
          const groupId = `agent-thread-group-${encodeURIComponent(key)}`;
          const historyId = `${groupId}-history`;
          const renderThreadRow = (row: AgentThreadRow) => {
            const selected = row.id === currentSessionId;
            const unread = isThreadUnread(row, unreadState);
            const activeResult = row.id === activeResultId;
            const rowClassName = `agent-thread-row ${styles.threadRow} ${selected ? 'selected' : ''} ${unread ? 'unread' : ''} ${activeResult ? 'active-result' : ''} status-${row.status}`;
            const menuItems = ({ closeMenu }: { closeMenu: () => void }) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`Mark ${row.title} as unread`}
                  onClick={(event) => {
                    event.stopPropagation();
                    markUnread(row.id, row.updatedAt);
                    closeMenu();
                  }}
                >
                  Mark unread
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`Copy path for ${row.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyPath(row);
                    closeMenu();
                  }}
                >
                  Copy path
                </button>
              </>
            );
            const renderThreadLink = (
              lifecycleProps?: RuntimeLifecycleThreadProps,
            ) => (
              <AgentThreadLink
                row={row}
                selected={selected}
                unread={unread}
                activeResult={activeResult}
                onSelect={() => select(row.id)}
                lifecycleProps={lifecycleProps}
              />
            );
            if (!row.runtime) {
              return (
                <AgentThreadActionMenu
                  key={row.id}
                  title={row.title}
                  rowClassName={rowClassName}
                  menuItems={menuItems}
                >
                  {renderThreadLink}
                </AgentThreadActionMenu>
              );
            }
            return (
              <RuntimeLifecycleActions
                key={row.id}
                runtime={row.runtime}
                title={row.title}
                rowClassName={rowClassName}
                menuItems={menuItems}
              >
                {renderThreadLink}
              </RuntimeLifecycleActions>
            );
          };
          return (
            <section className={styles.workspaceGroup} key={key}>
              <div className={styles.workspaceHeading}>
                <button
                  type="button"
                  className={styles.workspaceHeadingToggle}
                  aria-expanded={expanded}
                  aria-controls={groupId}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.workspaceName}`}
                  onClick={() => toggleWorkspace(key)}
                >
                  <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                  <span className={styles.workspaceHeadingName}>
                    {group.workspaceName}
                  </span>
                  <small>{group.rows.length}</small>
                </button>
                <span className={styles.workspaceHeadingActions}>
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
                  <div className={styles.shelfHeading}>
                    <span>Active</span>
                    <small>{activeRows.length}</small>
                  </div>
                  {activeRows.map(renderThreadRow)}
                  <button
                    type="button"
                    className={styles.shelfHeading}
                    aria-expanded={historyExpanded}
                    aria-controls={historyId}
                    aria-label={`${historyExpanded ? 'Collapse' : 'Expand'} History in ${group.workspaceName}`}
                    onClick={() => toggleHistory(key)}
                  >
                    <span>History</span>
                    <small>{historyRows.length}</small>
                    <span aria-hidden="true">
                      {historyExpanded ? '▾' : '▸'}
                    </span>
                  </button>
                  <div id={historyId}>
                    {visibleHistoryRows.map(renderThreadRow)}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
      {hiddenRowCount > 0 && !query.trim() && (
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
