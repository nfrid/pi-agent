import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useMemo, useState } from 'react';
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
  type AgentThreadNavMode,
  useAgentThreadDrawer,
} from './agent-thread-nav/use-agent-thread-drawer';
import styles from './agent-thread-nav.module.css';
import { useDashboardUtility } from './dashboard-utility-context';
import {
  RuntimeLifecycleActions,
  type RuntimeLifecycleThreadProps,
} from './runtime-actions';
import { DashboardTime } from './timestamp';
import { UsageCapsule } from './usage-indicator';

export type { AgentThreadRow } from './agent-thread-nav/model';
export {
  agentThreadRows,
  boundedAgentThreadRows,
  workspaceNameForSession,
} from './agent-thread-nav/model';

function AgentThreadLink({
  row,
  selected,
  onSelect,
  lifecycleProps,
}: {
  row: AgentThreadRow;
  selected: boolean;
  onSelect: () => void;
  lifecycleProps?: RuntimeLifecycleThreadProps;
}) {
  return (
    <button
      {...lifecycleProps}
      type="button"
      className={`agent-thread-link ${styles.threadLink}`}
      aria-current={selected ? 'page' : undefined}
      aria-label={`${row.title} ${statusLabel(row)}`}
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
          <span className={`agent-thread-context ${styles.threadContext}`}>
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
    () => boundedAgentThreadRows(filtered, historyLimit),
    [filtered, historyLimit],
  );
  const hiddenRowCount = hiddenAgentThreadRowCount(filtered, visibleRows);
  const groups = useMemo(
    () => groupAgentThreadRows(visibleRows),
    [visibleRows],
  );
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
      <div className={`agent-nav-header ${styles.header}`}>
        <div>
          <p className="eyebrow">Workspace threads</p>
          <strong>Agents</strong>
        </div>
      </div>
      <label className={`agent-nav-search ${styles.search}`}>
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
      <div className={`agent-nav-list ${styles.list}`}>
        {!groups.length && (
          <p className={`agent-nav-empty ${styles.empty}`}>
            No matching threads.
          </p>
        )}
        {groups.map(([key, group]) => (
          <section
            className={`agent-workspace-group ${styles.workspaceGroup}`}
            key={key}
          >
            <div
              className={`agent-workspace-heading ${styles.workspaceHeading}`}
            >
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
              <span
                className={`agent-workspace-heading-actions ${styles.workspaceHeadingActions}`}
              >
                <small>{group.rows.length}</small>
                {group.workspaceId && (
                  <button
                    type="button"
                    className={`agent-workspace-new ${styles.workspaceNew}`}
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
              const rowClassName = `agent-thread-row ${styles.threadRow} ${selected ? 'selected' : ''} status-${row.status}`;
              const renderThreadLink = (
                lifecycleProps?: RuntimeLifecycleThreadProps,
              ) => (
                <AgentThreadLink
                  row={row}
                  selected={selected}
                  onSelect={() => select(row.id)}
                  lifecycleProps={lifecycleProps}
                />
              );

              if (!row.runtime) {
                return (
                  <div className={rowClassName} key={row.id}>
                    {renderThreadLink()}
                  </div>
                );
              }
              return (
                <RuntimeLifecycleActions
                  key={row.id}
                  runtime={row.runtime}
                  title={row.title}
                  rowClassName={rowClassName}
                >
                  {renderThreadLink}
                </RuntimeLifecycleActions>
              );
            })}
          </section>
        ))}
      </div>
      {hiddenRowCount > 0 && (
        <button
          type="button"
          className={`agent-nav-more ${styles.more}`}
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
        className={`agent-nav-footer ${styles.footer} ${mode === 'session' ? styles.sessionFooter : ''}`}
      >
        <button
          type="button"
          className={`agent-nav-utility ${styles.utility}`}
          onClick={() => openUtility('workspaces', '/workspaces')}
        >
          <span aria-hidden="true">⌂</span>
          <span>Workspaces</span>
        </button>
        <button
          type="button"
          className={`agent-nav-utility ${styles.utility}`}
          onClick={() => openUtility('sessions', '/sessions')}
        >
          <span aria-hidden="true">▤</span>
          <span>History</span>
        </button>
        <button
          type="button"
          className={`agent-nav-utility ${styles.utility}`}
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
          className={`agent-nav-drawer ${styles.drawer} ${open ? 'open' : ''}${drawerExiting ? ' is-exiting' : ''}`}
          aria-hidden={isMobile && !open ? true : undefined}
        >
          {nav}
        </div>
      )}
    </>
  );
}
