import {
  dashboardHttpClient,
  sessionThreadLinksQueryOptions,
  threadsQueryOptions,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { sortWorkspacesByRecency } from '../app-helpers';
import { newChatPath, useDashboardNavigate } from '../routes/navigation';
import {
  type AgentThreadRow,
  agentThreadRows,
  boundedAgentThreadRows,
  filterAgentThreadRows,
  hiddenAgentThreadRowCount,
  isHistoryThread,
  MAX_VISIBLE_HISTORY_THREADS,
  searchAgentThreadRows,
  sectionAgentThreadRows,
  sessionThreadIdentityKey,
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
  AgentThreadActionMenu,
  DurableThreadActions,
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
  sectionAgentThreadRows,
  workspaceNameForSession,
} from './agent-thread-nav/model';

const COLLAPSED_HISTORY_KEY = 'pi-dashboard-collapsed-history-v1';
const EXPANDED_ARCHIVED_KEY = 'pi-dashboard-expanded-archived-v1';

type CollapsedHistory = Record<string, boolean>;
type ExpandedArchived = Record<string, boolean>;

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

function readExpandedArchived(): ExpandedArchived {
  try {
    const raw = globalThis.localStorage?.getItem(EXPANDED_ARCHIVED_KEY);
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

function writeExpandedArchived(state: ExpandedArchived): void {
  try {
    globalThis.localStorage?.setItem(
      EXPANDED_ARCHIVED_KEY,
      JSON.stringify(state),
    );
  } catch {
    // Storage can be unavailable in private browsing; expansion remains local.
  }
}

function WorkspaceChooser({
  workspaces,
  onChoose,
  onClose,
}: {
  workspaces: BrowserSnapshot['workspaces'];
  onChoose: (workspaceId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = workspaces.filter((workspace) =>
    `${workspace.name} ${workspace.canonicalPath} ${workspace.path}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  useEffect(() => {
    setActiveIndex((index) =>
      Math.min(index, Math.max(0, filtered.length - 1)),
    );
  }, [filtered.length]);

  const move = (direction: 1 | -1) => {
    if (!filtered.length) return;
    setActiveIndex(
      (index) => (index + direction + filtered.length) % filtered.length,
    );
  };
  const chooseActive = () => {
    const workspace = filtered[activeIndex];
    if (workspace) onChoose(workspace.id);
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: The backdrop closes the modal on outside clicks.
    <div
      className={styles.workspaceChooserBackdrop}
      data-workspace-chooser-backdrop=""
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.workspaceChooser}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-thread-workspace-chooser-heading"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (
            event.key === 'ArrowDown' ||
            (event.ctrlKey && event.key.toLowerCase() === 'j')
          ) {
            event.preventDefault();
            move(1);
          } else if (
            event.key === 'ArrowUp' ||
            (event.ctrlKey && event.key.toLowerCase() === 'k')
          ) {
            event.preventDefault();
            move(-1);
          } else if (
            event.key === 'Enter' &&
            event.target instanceof HTMLInputElement
          ) {
            event.preventDefault();
            chooseActive();
            return;
          }
          if (event.key !== 'Tab') return;
          event.stopPropagation();
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'input, button:not(:disabled)',
            ) ?? [],
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
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="agent-thread-workspace-chooser-heading">Choose a workspace</h2>
        <p>Where should the new thread start?</p>
        <input
          ref={searchRef}
          className={styles.workspaceChooserSearch}
          aria-label="Search workspaces"
          placeholder="Search name or path"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
        />
        <fieldset className={styles.workspaceChooserOptions}>
          <legend className={styles.workspaceChooserLegend}>Workspaces</legend>
          {filtered.map((workspace, index) => (
            <button
              type="button"
              aria-label={workspace.name}
              data-workspace-active={index === activeIndex ? 'true' : undefined}
              key={workspace.id}
              onClick={() => onChoose(workspace.id)}
            >
              <span>{workspace.name}</span>
              <small className={styles.workspaceChooserPath}>
                {workspace.canonicalPath}
              </small>
            </button>
          ))}
          {!filtered.length && (
            <span className={styles.workspaceChooserEmpty}>
              No matching workspaces.
            </span>
          )}
        </fieldset>
        <button
          type="button"
          className={styles.workspaceChooserCancel}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

// Per-row actions are rendered in the shared accessible context menu below.
function AgentThreadLink({
  row,
  selected,
  unread,
  activeResult,
  density,
  onSelect,
  lifecycleProps,
}: {
  row: AgentThreadRow;
  selected: boolean;
  unread: boolean;
  activeResult: boolean;
  density: 'card' | 'slim';
  onSelect: () => void;
  lifecycleProps?: RuntimeLifecycleThreadProps;
}) {
  return (
    <button
      {...lifecycleProps}
      type="button"
      className={styles.threadLink}
      aria-current={selected ? 'page' : undefined}
      data-row-density={density}
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
        {density === 'card' && (
          <span className={styles.threadWorkspace} data-row-content="workspace">
            <span>{row.workspaceName}</span>
            <span className={styles.threadMeta}>
              {[
                'working',
                'compacting',
                'waiting',
                'input',
                'failed',
                'paused',
              ].includes(row.status) ? (
                statusLabel(row)
              ) : row.updatedAt === undefined ? (
                statusLabel(row)
              ) : (
                <DashboardTime
                  className={`agent-thread-time ${styles.threadTime}`}
                  timestamp={row.updatedAt}
                  context="sidebar-relative"
                />
              )}
            </span>
            {row.durableThread?.pinnedAt !== undefined && (
              <span
                className={styles.threadPin}
                title="Pinned"
                role="img"
                aria-label="Pinned"
              >
                •
              </span>
            )}
          </span>
        )}
        {density === 'slim' && (
          <span className={styles.threadWorkspace} data-row-content="workspace">
            <span>{row.workspaceName}</span>
          </span>
        )}
        <strong>{row.title}</strong>
        {density === 'slim' &&
          (row.updatedAt === undefined ? (
            <span className={styles.threadTime}>{statusLabel(row)}</span>
          ) : (
            <DashboardTime
              className={`agent-thread-time ${styles.threadTime}`}
              timestamp={row.updatedAt}
              context="sidebar-relative"
            />
          ))}
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
  const [workspaceScope, setWorkspaceScope] = useState('all');
  const [workspaceChooserOpen, setWorkspaceChooserOpen] = useState(false);
  const newThreadButtonRef = useRef<HTMLButtonElement>(null);
  const [historyCollapsed, setHistoryCollapsed] = useState(() =>
    Boolean(readCollapsedHistory().all),
  );
  const [archivedExpanded, setArchivedExpanded] = useState(() =>
    Boolean(readExpandedArchived().all),
  );
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
  const durableThreadsQuery = useQuery(
    threadsQueryOptions(dashboardHttpClient),
  );
  const sessionThreadLinksQuery = useQuery(
    sessionThreadLinksQueryOptions(dashboardHttpClient),
  );
  const durableThreads = durableThreadsQuery.isSuccess
    ? durableThreadsQuery.data
    : undefined;
  const directLinks = sessionThreadLinksQuery.isSuccess
    ? sessionThreadLinksQuery.data
    : [];
  const sessionIdentityKey = useMemo(
    () => sessionThreadIdentityKey(snapshot),
    [snapshot],
  );
  const priorSessionIdentityKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (priorSessionIdentityKey.current === undefined) {
      priorSessionIdentityKey.current = sessionIdentityKey;
      return;
    }
    if (priorSessionIdentityKey.current === sessionIdentityKey) return;
    priorSessionIdentityKey.current = sessionIdentityKey;
    void sessionThreadLinksQuery.refetch();
  }, [sessionIdentityKey, sessionThreadLinksQuery]);
  const workspaces = useMemo(
    () => sortWorkspacesByRecency(snapshot),
    [snapshot],
  );
  const rows = useMemo(
    () => agentThreadRows(snapshot, durableThreads, directLinks),
    [directLinks, durableThreads, snapshot],
  );
  const scopedRows = useMemo(
    () =>
      workspaceScope === 'all'
        ? rows
        : rows.filter((row) => row.workspaceId === workspaceScope),
    [rows, workspaceScope],
  );
  const filtered = useMemo(
    () => filterAgentThreadRows(scopedRows, query),
    [query, scopedRows],
  );
  const visibleRows = useMemo(
    () =>
      query.trim()
        ? searchAgentThreadRows(filtered)
        : boundedAgentThreadRows(filtered, historyLimit, currentSessionId),
    [currentSessionId, filtered, historyLimit, query],
  );
  const sections = useMemo(
    () => sectionAgentThreadRows(visibleRows, Number.POSITIVE_INFINITY),
    [visibleRows],
  );
  const hiddenRowCount = hiddenAgentThreadRowCount(filtered, visibleRows);
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
  const toggleHistory = () => {
    setHistoryCollapsed((current) => {
      const next = !current;
      writeCollapsedHistory(next ? { all: true } : {});
      return next;
    });
  };
  const toggleArchived = () => {
    setArchivedExpanded((current) => {
      const next = !current;
      writeExpandedArchived(next ? { all: true } : {});
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
  const openNewThread = () => {
    if (workspaceScope !== 'all') {
      go(newChatPath(snapshot, workspaceScope));
      if (mode === 'session') onOpenChange?.(false);
      return;
    }
    if (snapshot.workspaces.length === 0) {
      go('/workspaces');
      if (mode === 'session') onOpenChange?.(false);
      return;
    }
    if (workspaces.length === 1) {
      go(newChatPath(snapshot, workspaces[0].id));
      if (mode === 'session') onOpenChange?.(false);
      return;
    }
    setWorkspaceChooserOpen(true);
  };
  const closeWorkspaceChooser = () => {
    setWorkspaceChooserOpen(false);
    requestAnimationFrame(() => newThreadButtonRef.current?.focus());
  };
  const chooseWorkspace = (workspaceId: string) => {
    setWorkspaceChooserOpen(false);
    go(newChatPath(snapshot, workspaceId));
    if (mode === 'session') onOpenChange?.(false);
  };
  const renderThreadRow = (row: AgentThreadRow, density: 'card' | 'slim') => {
    const selected = row.id === currentSessionId;
    const unread = isThreadUnread(row, unreadState);
    const activeResult = row.id === activeResultId;
    const rowClassName = `agent-thread-row ${density === 'card' ? 'agent-thread-card' : 'agent-thread-slim'} ${styles.threadRow} ${selected ? 'selected' : ''} ${unread ? 'unread' : ''} ${activeResult ? 'active-result' : ''} status-${row.status}`;
    const menuItems = ({ closeMenu }: { closeMenu: () => void }) => (
      <>
        {row.durableThread && (
          <DurableThreadActions
            thread={row.durableThread}
            title={row.title}
            closeMenu={closeMenu}
          />
        )}
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
    const renderThreadLink = (lifecycleProps?: RuntimeLifecycleThreadProps) => (
      <AgentThreadLink
        row={row}
        selected={selected}
        unread={unread}
        activeResult={activeResult}
        density={density}
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
        </div>
        <button
          ref={newThreadButtonRef}
          type="button"
          className={styles.newThread}
          aria-label="New thread"
          onClick={openNewThread}
        >
          <span aria-hidden="true">+</span> New
        </button>
      </div>
      {workspaceChooserOpen && (
        <WorkspaceChooser
          workspaces={workspaces}
          onChoose={chooseWorkspace}
          onClose={closeWorkspaceChooser}
        />
      )}
      <div className={styles.search}>
        <span aria-hidden="true">⌕</span>
        <input
          aria-label="Search agents and threads"
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
      </div>
      <label className={styles.scope}>
        <span>Workspace</span>
        <select
          aria-label="Workspace scope"
          value={workspaceScope}
          onChange={(event) => {
            setWorkspaceScope(event.target.value);
            setHistoryLimit(MAX_VISIBLE_HISTORY_THREADS);
          }}
        >
          <option value="all">All workspaces</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.list}>
        {!visibleRows.length && (
          <p className={styles.empty}>No matching threads.</p>
        )}
        {sections.pinned.length > 0 && (
          <section aria-label="Pinned threads">
            <h3 className={styles.shelfHeading}>
              <span>Pinned</span>
              <small>{sections.pinned.length}</small>
            </h3>
            {sections.pinned.map((row) => renderThreadRow(row, 'card'))}
          </section>
        )}
        {sections.active.length > 0 && (
          <section aria-label="Active threads">
            <h3 className={styles.shelfHeading}>
              <span>Active</span>
              <small>{sections.active.length}</small>
            </h3>
            {sections.active.map((row) => renderThreadRow(row, 'card'))}
          </section>
        )}
        {(sections.history.length > 0 || filtered.some(isHistoryThread)) && (
          <>
            <button
              type="button"
              className={styles.shelfHeading}
              aria-expanded={!historyCollapsed || Boolean(query.trim())}
              aria-controls="agent-thread-history"
              aria-label={`${historyCollapsed && !query.trim() ? 'Expand' : 'Collapse'} History`}
              onClick={toggleHistory}
            >
              <span>History</span>
              <small>{filtered.filter(isHistoryThread).length}</small>
              <span aria-hidden="true">
                {historyCollapsed && !query.trim() ? '▸' : '▾'}
              </span>
            </button>
            <section
              id="agent-thread-history"
              className={styles.compactShelf}
              aria-label="History threads"
            >
              {(historyCollapsed && !query.trim()
                ? sections.history.filter((row) => row.id === currentSessionId)
                : sections.history
              ).map((row) => renderThreadRow(row, 'slim'))}
            </section>
          </>
        )}
        {sections.archived.length > 0 && (
          <>
            <button
              type="button"
              className={styles.shelfHeading}
              aria-expanded={archivedExpanded || Boolean(query.trim())}
              aria-controls="agent-thread-archived"
              aria-label={`${archivedExpanded || query.trim() ? 'Collapse' : 'Expand'} Archived`}
              onClick={toggleArchived}
            >
              <span>Archived</span>
              <small>{sections.archived.length}</small>
              <span aria-hidden="true">
                {archivedExpanded || query.trim() ? '▾' : '▸'}
              </span>
            </button>
            <section
              id="agent-thread-archived"
              className={styles.compactShelf}
              aria-label="Archived threads"
            >
              {(archivedExpanded || query.trim()
                ? sections.archived
                : sections.archived.filter((row) => row.id === currentSessionId)
              ).map((row) => renderThreadRow(row, 'slim'))}
            </section>
          </>
        )}
      </div>
      {hiddenRowCount > 0 && !query.trim() && !historyCollapsed && (
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
