import {
  archiveThreadMutationOptions,
  dashboardHttpClient,
  pinThreadMutationOptions,
  restoreThreadMutationOptions,
  sessionThreadLinksQueryOptions,
  settleThreadMutationOptions,
  threadsQueryOptions,
  unpinThreadMutationOptions,
  unsettleThreadMutationOptions,
} from '@pi-dashboard/client';
import type { BrowserSnapshot, CheckoutSummary } from '@pi-dashboard/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  newProjectThreadPath,
  useDashboardNavigate,
} from '../routes/navigation';
import {
  type AgentThreadRow,
  agentThreadRows,
  type BulkThreadAction,
  bulkThreadActions,
  canSettleThread,
  filterAgentThreadRows,
  hiddenAgentThreadRowCount,
  isArchivedThread,
  MAX_VISIBLE_ACTIVE_THREADS,
  resolvedDraftPromotionIds,
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
import { dormantResumeMetadata } from './composer/runtime';
import { useDashboardSurfaces } from './dashboard-surface-context';
import { deleteDraft, draftPath, useDrafts } from './drafts';
import {
  hasActiveDrawerHistoryEntry,
  useDrawerHistory,
} from './drawer-history';
import {
  type ModelDisplayPreferences,
  modelDisplayPreference,
  useModelDisplayPreferences,
} from './model-display-preferences';
import { draftModelSelection } from './model-option';
import {
  AgentThreadActionMenu,
  DurableThreadActions,
  QuickSettleThreadAction,
  RuntimeLifecycleActions,
  type RuntimeLifecycleThreadProps,
  refreshDurableThreadMetadata,
} from './runtime-actions';
import { AgentNavDrawerShell } from './surface-stack';
import { DashboardTime } from './timestamp';
import { UsageCapsule } from './usage-indicator';

export type { AgentThreadRow } from './agent-thread-nav/model';
export {
  agentThreadRows,
  projectNameForSession,
  sectionAgentThreadRows,
} from './agent-thread-nav/model';

const EXPANDED_ARCHIVED_KEY = 'pi-dashboard-expanded-archived-v1';

const BULK_ACTION_LABELS: Record<BulkThreadAction, string> = {
  archive: 'Archive',
  restore: 'Restore',
  pin: 'Pin',
  unpin: 'Unpin',
  settle: 'Settle',
  unsettle: 'Unsettle',
};

type ExpandedArchived = Record<string, boolean>;

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

export type ThreadMetadataPresentation = {
  branch: string;
  checkoutKind: CheckoutSummary['kind'];
  model?: {
    provider: string;
    id: string;
    alias: string;
    color: string;
  };
  effort: {
    full: string;
    compact: string;
    color: string;
  };
  queue?: number;
  time?: number;
  checkoutPath: string;
};

const EFFORT_LABELS: Record<string, string> = {
  off: '–',
  minimal: 'min',
  low: 'l',
  medium: 'm',
  high: 'h',
  xhigh: 'xh',
  max: 'max',
};
const EFFORT_COLORS: Record<string, string> = {
  off: 'muted',
  minimal: 'green',
  low: 'green',
  medium: 'cyan',
  high: 'orange',
  xhigh: 'pink',
  max: 'pink',
};
const DEFAULT_MODEL_COLOR = '#8be9fd';

function checkoutIdForRow(row: AgentThreadRow): string | undefined {
  if (row.runtime?.checkoutId) return row.runtime.checkoutId;
  if (row.durableThread?.checkoutId) return row.durableThread.checkoutId;
  const location = row.draft?.location;
  return location?.kind === 'checkout' ? location.checkoutId : undefined;
}

export function activeThreadDetails(
  row: AgentThreadRow,
  runtimes: BrowserSnapshot['runtimes'],
  checkouts: readonly CheckoutSummary[] = [],
  preferences: ModelDisplayPreferences = {},
  time = row.updatedAt,
): ThreadMetadataPresentation {
  const indexed = dormantResumeMetadata(row.session, runtimes);
  const draftSelection = row.draft
    ? draftModelSelection(runtimes, row.draft.model)
    : undefined;
  const selectedModel = row.draft
    ? draftSelection
    : (row.runtime?.model ?? indexed.model);
  const catalogModel = selectedModel
    ? runtimes
        .flatMap((runtime) => runtime.modelCatalog ?? [])
        .find(
          (candidate) =>
            candidate.provider === selectedModel.provider &&
            candidate.model === selectedModel.model,
        )
    : undefined;
  const preference = selectedModel
    ? modelDisplayPreference(
        preferences,
        selectedModel.provider,
        selectedModel.model,
      )
    : {};
  const model = selectedModel
    ? {
        provider: selectedModel.provider,
        id: `${selectedModel.provider}/${selectedModel.model}`,
        alias: preference.alias ?? catalogModel?.name ?? selectedModel.model,
        color: preference.color ?? DEFAULT_MODEL_COLOR,
      }
    : undefined;
  const fullEffort = row.draft
    ? draftSelection?.thinking
    : (row.runtime?.model?.thinking ?? indexed.thinking);
  const effortKey = fullEffort ?? '';
  const effort = {
    full: fullEffort ?? '? effort',
    compact: EFFORT_LABELS[effortKey] ?? fullEffort ?? '?',
    color: EFFORT_COLORS[effortKey] ?? 'purple',
  };
  const checkoutId = checkoutIdForRow(row);
  const checkout = checkoutId
    ? checkouts.find((candidate) => candidate.id === checkoutId)
    : undefined;
  return {
    branch: checkout?.branch ?? 'main',
    checkoutKind:
      checkout?.kind ??
      (row.draft?.location?.kind === 'worktree' ? 'worktree' : 'main'),
    ...(model ? { model } : {}),
    effort,
    ...((row.runtime?.queueDrafts?.length ?? 0) > 0
      ? { queue: row.runtime?.queueDrafts?.length }
      : {}),
    time,
    checkoutPath: checkout?.path ?? '',
  };
}

// Per-row actions are rendered in the shared accessible context menu below.
function QuickDeleteDraftAction({
  draftId,
  title,
}: {
  draftId: string;
  title: string;
}) {
  return (
    <button
      type="button"
      className={styles.quickDeleteDraft}
      aria-label={`Delete draft ${title}`}
      title="Delete draft"
      onClick={(event) => {
        event.stopPropagation();
        deleteDraft(draftId);
      }}
    >
      <span aria-hidden="true">×</span>
    </button>
  );
}

function AgentThreadLink({
  row,
  selected,
  bulkSelected,
  unread,
  activeResult,
  density,
  selectionDisabled,
  onSelect,
  lifecycleProps,
  lifecycleStatus,
  runtimes,
  checkouts,
  preferences,
}: {
  row: AgentThreadRow;
  selected: boolean;
  bulkSelected: boolean;
  unread: boolean;
  activeResult: boolean;
  density: 'card' | 'slim';
  selectionDisabled: boolean;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  lifecycleProps?: RuntimeLifecycleThreadProps;
  lifecycleStatus?: 'restarting';
  runtimes: BrowserSnapshot['runtimes'];
  checkouts: readonly CheckoutSummary[];
  preferences: ModelDisplayPreferences;
}) {
  const timestamp =
    density === 'slim' &&
    !isArchivedThread(row) &&
    row.durableThread?.settledAt !== undefined
      ? row.durableThread.settledAt
      : row.updatedAt;
  const details = activeThreadDetails(
    row,
    runtimes,
    checkouts,
    preferences,
    timestamp,
  );
  const showDetails = density === 'card';
  return (
    <button
      {...lifecycleProps}
      type="button"
      className={styles.threadLink}
      disabled={selectionDisabled}
      aria-current={selected ? 'page' : undefined}
      data-bulk-selected={bulkSelected ? 'true' : undefined}
      data-row-density={density}
      data-search-active={activeResult ? '' : undefined}
      aria-label={`${row.title} ${lifecycleStatus ?? statusLabel(row)}${unread ? ' unread' : ''}${bulkSelected ? ' selected for bulk actions' : ''}`}
      onClick={onSelect}
    >
      <span className={`agent-thread-copy ${styles.threadCopy}`}>
        <span className={styles.threadWorkspace} data-row-content="project">
          <span className={styles.threadWorkspaceName}>{row.projectName}</span>
          {density === 'slim' && (
            <span className={styles.threadWorkspaceCheckout}>
              <span
                className={styles.threadWorkspaceSeparator}
                aria-hidden="true"
              >
                /
              </span>
              <span
                className={styles.threadCheckout}
                data-checkout-kind={details.checkoutKind}
                title={details.checkoutPath || details.branch}
              >
                {details.branch}
              </span>
            </span>
          )}
          {density === 'card' && row.durableThread?.pinnedAt !== undefined && (
            <span
              className={styles.threadPin}
              title="Pinned"
              role="img"
              aria-label="Pinned"
            >
              •
            </span>
          )}
          <span className={styles.threadMeta}>
            {density === 'card' ? (
              (lifecycleStatus ?? statusLabel(row))
            ) : timestamp === undefined ? (
              (lifecycleStatus ?? statusLabel(row))
            ) : (
              <DashboardTime
                className={`agent-thread-time ${styles.threadTime}`}
                timestamp={timestamp}
                context="sidebar-relative"
              />
            )}
            <span
              className={`agent-thread-glyph ${styles.threadGlyph}`}
              aria-hidden="true"
            >
              {lifecycleStatus ? '◐' : statusGlyph(row.status)}
            </span>
          </span>
        </span>
        <strong>{row.title}</strong>
        {showDetails && (
          <small
            className={styles.threadDetails}
            data-row-content="details"
            title={[
              `Model: ${details.model?.id ?? 'unknown'}`,
              `Effort: ${details.effort.full}`,
              `Branch: ${details.branch}`,
              ...(details.checkoutPath
                ? [`Checkout: ${details.checkoutPath}`]
                : []),
            ].join('; ')}
          >
            <span
              className={styles.threadCheckout}
              data-checkout-kind={details.checkoutKind}
            >
              {details.branch}
            </span>
            <span
              className={styles.threadModel}
              style={details.model ? { color: details.model.color } : undefined}
            >
              {details.model?.alias ?? '? model'}
            </span>
            <span
              className={styles.threadEffort}
              data-effort={details.effort.full}
            >
              {details.effort.compact}
            </span>
            {details.queue !== undefined && (
              <>
                <span className={styles.threadSeparator} aria-hidden="true">
                  ·
                </span>
                <span className={styles.threadQueue}>
                  {details.queue} queued
                </span>
              </>
            )}
            {details.time !== undefined && (
              <DashboardTime
                className={`agent-thread-time ${styles.threadTime}`}
                timestamp={details.time}
                context="sidebar-relative"
              />
            )}
          </small>
        )}
      </span>
    </button>
  );
}

export function AgentThreadNav({
  snapshot,
  mode = 'home',
  currentSessionId,
  currentDraftId,
  open = false,
  onOpenChange,
}: {
  snapshot: BrowserSnapshot;
  mode?: AgentThreadNavMode;
  currentSessionId?: string;
  currentDraftId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const go = useDashboardNavigate();
  const surfaces = useDashboardSurfaces();
  const queryClient = useQueryClient();
  const archive = useMutation(
    archiveThreadMutationOptions(dashboardHttpClient),
  );
  const restore = useMutation(
    restoreThreadMutationOptions(dashboardHttpClient),
  );
  const pin = useMutation(pinThreadMutationOptions(dashboardHttpClient));
  const unpin = useMutation(unpinThreadMutationOptions(dashboardHttpClient));
  const settle = useMutation(settleThreadMutationOptions(dashboardHttpClient));
  const unsettle = useMutation(
    unsettleThreadMutationOptions(dashboardHttpClient),
  );
  const [query, setQuery] = useState('');
  const [activeLimit, setActiveLimit] = useState(MAX_VISIBLE_ACTIVE_THREADS);
  const [projectScope, setProjectScope] = useState('all');
  const [archivedExpanded, setArchivedExpanded] = useState(() =>
    Boolean(readExpandedArchived().all),
  );
  const [activeResultId, setActiveResultId] = useState<string>();
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [bulkPendingAction, setBulkPendingAction] = useState<
    BulkThreadAction | undefined
  >(undefined);
  const [bulkError, setBulkError] = useState<string | undefined>(undefined);
  const modelDisplayPreferences = useModelDisplayPreferences();
  const selectionAnchorId = useRef<string | undefined>(undefined);
  useDrawerHistory(mode === 'session' && open, () => onOpenChange?.(false));
  const drafts = useDrafts();
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
  // Snapshot thread metadata is published with the live orchestration state;
  // never let a slower finite query overwrite it with stale lifecycle data.
  const durableThreads =
    snapshot.threads ??
    (durableThreadsQuery.isSuccess ? durableThreadsQuery.data : undefined);
  const directLinks = sessionThreadLinksQuery.isSuccess
    ? sessionThreadLinksQuery.data
    : [];
  const resolvedPromotions = useMemo(
    () => resolvedDraftPromotionIds(snapshot, directLinks, drafts),
    [directLinks, drafts, snapshot],
  );
  useEffect(() => {
    for (const draftId of resolvedPromotions) deleteDraft(draftId);
  }, [resolvedPromotions]);
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
  const projects = useMemo(
    () =>
      (snapshot.projects ?? []).filter(
        (project) => project.status === 'active',
      ),
    [snapshot.projects],
  );
  const rows = useMemo(
    () => agentThreadRows(snapshot, durableThreads, directLinks, drafts),
    [directLinks, drafts, durableThreads, snapshot],
  );
  const scopedRows = useMemo(
    () =>
      projectScope === 'all'
        ? rows
        : projectScope === 'unassigned'
          ? rows.filter((row) => !row.projectId)
          : rows.filter((row) => row.projectId === projectScope),
    [projectScope, rows],
  );
  const filtered = useMemo(
    () => filterAgentThreadRows(scopedRows, query),
    [query, scopedRows],
  );
  const sections = useMemo(
    () =>
      sectionAgentThreadRows(
        filtered,
        query.trim() ? Number.POSITIVE_INFINITY : activeLimit,
        currentDraftId ?? currentSessionId,
      ),
    [activeLimit, currentDraftId, currentSessionId, filtered, query],
  );
  const visibleRows = useMemo(
    () => [
      ...sections.pinned,
      ...sections.active,
      ...sections.settled,
      ...sections.archived,
    ],
    [sections],
  );
  const hiddenRowCount = hiddenAgentThreadRowCount(filtered, visibleRows);
  const displayedArchivedRows = useMemo(
    () =>
      archivedExpanded || query.trim()
        ? sections.archived
        : sections.archived.filter((row) => row.id === currentSessionId),
    [archivedExpanded, currentSessionId, query, sections.archived],
  );
  const selectableRows = useMemo(
    () =>
      [
        ...sections.pinned,
        ...sections.active,
        ...sections.settled,
        ...displayedArchivedRows,
      ].filter((row) => row.durableThread !== undefined),
    [displayedArchivedRows, sections],
  );
  const selectedRows = selectableRows.filter((row) =>
    selectedThreadIds.has(row.id),
  );
  const availableBulkActions = bulkThreadActions(selectedRows);
  const searchResultRows = query.trim() ? visibleRows : [];
  useEffect(() => {
    if (
      activeResultId &&
      !searchResultRows.some((row) => row.id === activeResultId)
    )
      setActiveResultId(undefined);
  }, [activeResultId, searchResultRows]);
  useEffect(() => {
    const selectableIds = new Set(selectableRows.map((row) => row.id));
    if ([...selectedThreadIds].some((id) => !selectableIds.has(id)))
      setSelectedThreadIds(
        new Set([...selectedThreadIds].filter((id) => selectableIds.has(id))),
      );
    if (
      selectionAnchorId.current &&
      !selectableIds.has(selectionAnchorId.current)
    )
      selectionAnchorId.current = undefined;
  }, [selectableRows, selectedThreadIds]);
  useEffect(() => {
    visitCurrent(rows);
  }, [rows, visitCurrent]);
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
  const clearBulkSelection = () => {
    setSelectedThreadIds(new Set());
    selectionAnchorId.current = undefined;
    setBulkError(undefined);
  };
  const runBulkAction = async (action: BulkThreadAction) => {
    const selectedThreads = selectedRows.flatMap((row) =>
      row.durableThread ? [row.durableThread] : [],
    );
    if (!selectedThreads.length || !availableBulkActions.includes(action))
      return;
    setBulkPendingAction(action);
    setBulkError(undefined);
    const results = await Promise.allSettled(
      selectedThreads.map((thread) => {
        const variables = { threadId: thread.threadId };
        if (action === 'archive') return archive.mutateAsync(variables);
        if (action === 'restore') return restore.mutateAsync(variables);
        if (action === 'pin') return pin.mutateAsync(variables);
        if (action === 'unpin') return unpin.mutateAsync(variables);
        if (action === 'settle') return settle.mutateAsync(variables);
        return unsettle.mutateAsync(variables);
      }),
    );
    await refreshDurableThreadMetadata(queryClient);
    const failedIds = selectedRows.flatMap((row, index) =>
      results[index]?.status === 'rejected' ? [row.id] : [],
    );
    if (failedIds.length) {
      setSelectedThreadIds(new Set(failedIds));
      selectionAnchorId.current = failedIds.at(-1);
      setBulkError(
        `${BULK_ACTION_LABELS[action]} failed for ${failedIds.length} of ${results.length} threads.`,
      );
    } else {
      clearBulkSelection();
    }
    setBulkPendingAction(undefined);
  };
  const select = (id: string) => {
    clearBulkSelection();
    const row = rows.find((candidate) => candidate.id === id);
    go(row?.draft ? draftPath(id) : `/sessions/${encodeURIComponent(id)}`);
    if (mode === 'session') onOpenChange?.(false);
  };
  const handleThreadClick = (
    row: AgentThreadRow,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    const additive = event.metaKey || event.ctrlKey;
    if (!row.durableThread || (!additive && !event.shiftKey)) {
      select(row.id);
      return;
    }
    event.preventDefault();
    setBulkError(undefined);
    if (event.shiftKey) {
      const anchorIndex = selectableRows.findIndex(
        (candidate) => candidate.id === selectionAnchorId.current,
      );
      const rowIndex = selectableRows.findIndex(
        (candidate) => candidate.id === row.id,
      );
      if (anchorIndex >= 0 && rowIndex >= 0) {
        const start = Math.min(anchorIndex, rowIndex);
        const end = Math.max(anchorIndex, rowIndex);
        setSelectedThreadIds(
          new Set(selectableRows.slice(start, end + 1).map((item) => item.id)),
        );
        return;
      }
    }
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
    selectionAnchorId.current = row.id;
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
  const openSettings = () => {
    if (
      mode === 'session' &&
      open &&
      surfaces &&
      hasActiveDrawerHistoryEntry()
    ) {
      window.addEventListener(
        'popstate',
        () => surfaces.open({ type: 'settings' }),
        {
          once: true,
        },
      );
      onOpenChange?.(false);
      return;
    }
    onOpenChange?.(false);
    surfaces?.open({ type: 'settings' });
  };
  const openNewThread = () => {
    if (projects.length > 1 && surfaces) {
      surfaces.replace({ type: 'new-thread-project' });
      return;
    }
    go(
      projects.length === 0
        ? '/projects'
        : newProjectThreadPath(snapshot, projects[0]?.id),
    );
    if (mode === 'session') onOpenChange?.(false);
  };
  const renderThreadRow = (row: AgentThreadRow, density: 'card' | 'slim') => {
    const selected = row.draft
      ? row.id === currentDraftId
      : row.id === currentSessionId;
    const bulkSelected = selectedThreadIds.has(row.id);
    const unread = row.draft ? false : isThreadUnread(row, unreadState);
    const activeResult = row.id === activeResultId;
    const rowClassName = `agent-thread-row ${density === 'card' ? 'agent-thread-card' : 'agent-thread-slim'} ${styles.threadRow} ${selected ? 'selected' : ''} ${unread ? 'unread' : ''} ${activeResult ? 'active-result' : ''} status-${row.status}`;
    const menuItems = ({ closeMenu }: { closeMenu: () => void }) => (
      <>
        {!row.draft && row.durableThread && (
          <DurableThreadActions
            thread={row.durableThread}
            title={row.title}
            closeMenu={closeMenu}
            canSettle={canSettleThread(row)}
          />
        )}
        {!row.draft && (
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
        )}
        {!row.draft && (
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
        )}
      </>
    );
    const renderThreadLink = (
      lifecycleProps?: RuntimeLifecycleThreadProps,
      lifecycleStatus?: 'restarting',
    ) => (
      <>
        <AgentThreadLink
          row={row}
          selected={selected}
          bulkSelected={bulkSelected}
          unread={unread}
          activeResult={activeResult}
          density={density}
          selectionDisabled={bulkPendingAction !== undefined}
          onSelect={(event) => handleThreadClick(row, event)}
          lifecycleProps={lifecycleProps}
          lifecycleStatus={lifecycleStatus}
          runtimes={snapshot.runtimes}
          checkouts={snapshot.checkouts ?? []}
          preferences={modelDisplayPreferences}
        />
        {row.draft && (
          <QuickDeleteDraftAction draftId={row.id} title={row.title} />
        )}
        {canSettleThread(row) && row.durableThread && (
          <QuickSettleThreadAction
            threadId={row.durableThread.threadId}
            title={row.title}
          />
        )}
      </>
    );
    if (row.draft) {
      return (
        <AgentThreadActionMenu
          key={row.id}
          title={row.title}
          rowClassName={rowClassName}
          menuItems={({ closeMenu }) => (
            <button
              type="button"
              role="menuitem"
              className={styles.lifecycleActionDanger}
              onClick={(event) => {
                event.stopPropagation();
                closeMenu();
                deleteDraft(row.id);
              }}
            >
              Delete draft
            </button>
          )}
        >
          {renderThreadLink}
        </AgentThreadActionMenu>
      );
    }
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
          <p className="eyebrow">Pi Dashboard</p>
        </div>
      </div>
      <div className={styles.search}>
        <span aria-hidden="true">⌕</span>
        <input
          aria-label="Search agents and threads"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveResultId(undefined);
            setActiveLimit(MAX_VISIBLE_ACTIVE_THREADS);
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
        <span>Project</span>
        <select
          aria-label="Project scope"
          value={projectScope}
          onChange={(event) => {
            setProjectScope(event.target.value);
            setActiveLimit(MAX_VISIBLE_ACTIVE_THREADS);
          }}
        >
          <option value="all">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
          <option value="unassigned">Unassigned</option>
        </select>
      </label>
      {selectedRows.length > 0 && (
        <div
          className={styles.bulkActions}
          role="toolbar"
          aria-label={`Actions for ${selectedRows.length} selected threads`}
        >
          <span>{selectedRows.length} selected</span>
          <div>
            {availableBulkActions.map((action) => (
              <button
                key={action}
                type="button"
                disabled={bulkPendingAction !== undefined}
                onClick={() => void runBulkAction(action)}
              >
                {bulkPendingAction === action
                  ? `${BULK_ACTION_LABELS[action]}…`
                  : BULK_ACTION_LABELS[action]}
              </button>
            ))}
            <button
              type="button"
              disabled={bulkPendingAction !== undefined}
              onClick={clearBulkSelection}
            >
              Clear
            </button>
          </div>
          {bulkError && <span role="alert">{bulkError}</span>}
        </div>
      )}
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
        <section aria-label="Active threads">
          <h3 className={styles.shelfHeading}>
            <span>Active</span>
            <small>{sections.active.length}</small>
            <button
              type="button"
              className={styles.newThread}
              aria-label="New thread"
              onClick={openNewThread}
            >
              + new
            </button>
          </h3>
          {sections.active.map((row) => renderThreadRow(row, 'card'))}
        </section>
        {sections.settled.length > 0 && (
          <section aria-label="Settled threads">
            <h3 className={styles.shelfHeading}>
              <span>Settled</span>
              <small>{sections.settled.length}</small>
            </h3>
            {sections.settled.map((row) => renderThreadRow(row, 'slim'))}
          </section>
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
              {displayedArchivedRows.map((row) => renderThreadRow(row, 'slim'))}
            </section>
          </>
        )}
      </div>
      {hiddenRowCount > 0 && !query.trim() && (
        <button
          type="button"
          className={styles.more}
          onClick={() =>
            setActiveLimit((current) => current + MAX_VISIBLE_ACTIVE_THREADS)
          }
        >
          Show next {Math.min(hiddenRowCount, MAX_VISIBLE_ACTIVE_THREADS)} older
          thread
          {Math.min(hiddenRowCount, MAX_VISIBLE_ACTIVE_THREADS) === 1
            ? ''
            : 's'}
        </button>
      )}
      <footer className={`agent-nav-footer ${styles.footer}`}>
        <UsageCapsule usage={snapshot.usage} />
        <button
          type="button"
          className={styles.settingsButton}
          aria-label="Open settings"
          onClick={openSettings}
        >
          <span aria-hidden="true">⚙</span>
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
