import {
  activeDelegateTranscriptQueryOptions,
  type DashboardLiveStore,
  dashboardHttpClient,
  dashboardQueryKeys,
  delegateHistoryQueryOptions,
  delegateHistoryRunQueryOptions,
  useDashboardStore,
} from '@pi-dashboard/client';
import {
  type ExtensionSurface,
  type ExtensionSurfacePlacement,
  tryParseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import type {
  ActiveDelegateTranscriptBaseline,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Value } from 'typebox/value';
import {
  DELEGATE_RENDERER_ID,
  type DelegateStatusViewModel,
  DelegateStatusViewModelSchema,
} from '../../../../extensions/delegate/contribution';
import {
  PAUSE_RENDERER_ID,
  type PauseStatusViewModel,
  PauseStatusViewModelSchema,
} from '../../../../extensions/pause/contribution';
import { SETTLED_BACKGROUND_RENDERER_ID } from '../../../../extensions/remote-control/contribution';
import { TASKS_RENDERER_ID } from '../../../../extensions/tasks/contribution';
import {
  type DashboardRendererContext,
  renderDashboardContribution,
} from '../renderer-registry';
import {
  type DelegateCompositeRun,
  delegateHistorySettledRunIds,
} from './delegate-history';
import { DelegateSurface } from './live-surface-renderers';

/** Compatibility export for callers that used the old dashboard-local name. */
export type { ExtensionSurface as LiveExtensionSurface } from '@pi-dashboard/extension-contributions';
export { DelegateTranscript } from './delegate-transcript-inspector';

type SurfacePlacement = 'main' | 'composer';

/** Map portable extension intent to this host's two available surface slots. */
export function dashboardSurfacePlacement(
  placement: ExtensionSurfacePlacement | undefined,
): SurfacePlacement {
  switch (placement) {
    case 'composer':
    case 'above-composer':
      return 'composer';
    case 'main':
    case 'left-rail':
    case 'right-rail':
    case undefined:
      return 'main';
  }
}

export function runtimeExtensionSurfaces(
  runtime: RuntimeSnapshot | undefined,
): readonly ExtensionSurface[] {
  const surfaces = runtime?.extensionSurfaces;
  if (!Array.isArray(surfaces)) return [];
  return surfaces.flatMap((surface) => {
    const parsed = tryParseExtensionSurface(surface);
    return parsed ? [parsed] : [];
  });
}

export function runtimePauseStatus(
  runtime: RuntimeSnapshot | undefined,
): PauseStatusViewModel | undefined {
  const surface = runtimeExtensionSurfaces(runtime).find(
    (candidate) => candidate.rendererId === PAUSE_RENDERER_ID,
  );
  return surface && Value.Check(PauseStatusViewModelSchema, surface.viewModel)
    ? (surface.viewModel as PauseStatusViewModel)
    : undefined;
}

/** Render only through the exact-ID, schema-validating static registry. */
export function renderLiveExtensionSurface(surface: ExtensionSurface) {
  const context: DashboardRendererContext = {
    surfaceId: surface.id,
    rendererId: surface.rendererId,
    placement: surface.placement,
  };
  return renderDashboardContribution(
    surface.rendererId,
    surface.viewModel,
    context,
  );
}

function delegateSurface(
  runtime: RuntimeSnapshot | undefined,
): { surface: ExtensionSurface; model: DelegateStatusViewModel } | undefined {
  const surface = runtimeExtensionSurfaces(runtime).find(
    (candidate) => candidate.rendererId === DELEGATE_RENDERER_ID,
  );
  if (
    !surface ||
    !Value.Check(DelegateStatusViewModelSchema, surface.viewModel)
  )
    return undefined;
  return {
    surface,
    model: surface.viewModel as DelegateStatusViewModel,
  };
}

function isActiveDelegateState(state: string, pauseState?: string): boolean {
  return (
    state === 'pausing' ||
    state === 'paused' ||
    pauseState === 'pausing' ||
    pauseState === 'paused' ||
    state === 'queued' ||
    state === 'running'
  );
}

/** Reconcile one session's live run keys without retaining removed overlays. */
export function reconcileDelegateLiveRuns(
  sessionId: string,
  previous: ReadonlyMap<string, string>,
  liveRows: readonly Pick<
    DelegateStatusViewModel['statuses'][number],
    'runId' | 'state' | 'pauseState'
  >[],
): {
  next: Map<string, string>;
  shouldInvalidate: boolean;
  settledRunIds: string[];
} {
  const next = new Map(previous);
  const currentKeys = new Set<string>();
  const settledRunIds: string[] = [];
  let shouldInvalidate = false;
  for (const row of liveRows) {
    const key = `${sessionId}:${row.runId}`;
    currentKeys.add(key);
    const prior = next.get(key);
    const current = row.pauseState ?? row.state;
    if (
      prior &&
      isActiveDelegateState(prior) &&
      !isActiveDelegateState(current)
    ) {
      shouldInvalidate = true;
      settledRunIds.push(row.runId);
    }
    next.set(key, current);
  }
  for (const key of next.keys()) {
    if (!key.startsWith(`${sessionId}:`)) {
      next.delete(key);
      continue;
    }
    if (!currentKeys.has(key)) {
      // A terminal row can disappear as part of the same publication that
      // clears the live surface. Keep its settlement in the bounded refresh
      // path so a queued launch placeholder cannot mask the pending history
      // write. A queued/running disappearance is not settlement evidence.
      const prior = next.get(key);
      if (prior !== undefined && !isActiveDelegateState(prior))
        settledRunIds.push(key.slice(`${sessionId}:`.length));
      // Remove disappeared keys before the caller schedules invalidation. A
      // later render therefore cannot invalidate the same disappearance loop.
      next.delete(key);
      shouldInvalidate = true;
    }
  }
  return { next, shouldInvalidate, settledRunIds };
}

type DelegateSurfaceTranscriptEntry = NonNullable<
  DelegateStatusViewModel['statuses'][number]['transcript']
>[number];

function delegateTranscriptEntryKey(
  lineageId: string,
  runId: string,
  entry: { id: string; run?: number },
): string {
  return `${lineageId}:${runId}:${entry.run ?? 1}:${entry.id}`;
}

export function activeDelegateTranscriptBaselineFor(
  baseline: ActiveDelegateTranscriptBaseline | undefined,
  options: {
    sessionId: string;
    serverId: string | undefined;
    runtimeId: string | undefined;
    fetching: boolean;
  },
): ActiveDelegateTranscriptBaseline | undefined {
  if (
    !baseline ||
    options.fetching ||
    baseline.sessionId !== options.sessionId ||
    (options.serverId !== undefined &&
      baseline.serverId !== options.serverId) ||
    (baseline.runtimeId !== undefined &&
      baseline.runtimeId !== options.runtimeId)
  )
    return undefined;
  return baseline;
}

/** Merge the one-time active baseline behind the current runtime projection. */
export function overlayActiveDelegateTranscripts(
  liveRows: readonly DelegateStatusViewModel['statuses'][number][],
  baseline: ActiveDelegateTranscriptBaseline | undefined,
): DelegateStatusViewModel['statuses'] {
  if (!baseline) return [...liveRows];
  const baselineByRun = new Map(
    baseline.runs.map((run) => [`${run.lineageId}:${run.runId}`, run]),
  );
  return liveRows.map((row) => {
    if (!isActiveDelegateState(row.state, row.pauseState)) return row;
    const run = baselineByRun.get(`${row.lineageId}:${row.runId}`);
    if (!run) return row;
    const entries = new Map<string, DelegateSurfaceTranscriptEntry>();
    for (const entry of run.transcript)
      entries.set(
        delegateTranscriptEntryKey(run.lineageId, run.runId, entry),
        entry as DelegateSurfaceTranscriptEntry,
      );
    for (const entry of row.transcript ?? [])
      entries.set(
        delegateTranscriptEntryKey(row.lineageId, row.runId, entry),
        entry,
      );
    return {
      ...row,
      transcript: [...entries.values()],
      transcriptTruncated:
        row.transcriptTruncated === true || run.transcriptTruncated === true,
    };
  });
}

export function shouldFetchDelegateDetail(
  run: Pick<DelegateCompositeRun, 'persisted' | 'live' | 'row'>,
): boolean {
  if (run.persisted !== true) return false;
  // Active live data is authoritative while the child is running. Every
  // persisted non-active run uses durable detail, even if its live overlay is
  // partial or still retained after settlement.
  return !(
    run.live === true &&
    isActiveDelegateState(run.row.state, run.row.pauseState)
  );
}

export function shouldClearDelegateDetailSelection(options: {
  ownerMatches: boolean;
  fetching: boolean;
  runExists: boolean;
}): boolean {
  return (
    !options.ownerMatches || (!options.fetching && options.runExists === false)
  );
}

export function shouldPromoteDelegateDetailSelection(options: {
  shouldFetch: boolean;
  ownerMatches: boolean;
  fetching: boolean;
  persistedRunExists: boolean;
  liveActive: boolean;
}): boolean {
  return (
    !options.shouldFetch &&
    options.ownerMatches &&
    !options.fetching &&
    options.persistedRunExists &&
    !options.liveActive
  );
}

export function delegateHistoryRunIds(
  history: import('@pi-dashboard/protocol').DelegateHistoryResponse | undefined,
): ReadonlySet<string> {
  return new Set(
    history?.groups.flatMap((group) => group.runs.map((run) => run.runId)) ??
      [],
  );
}

const DELEGATE_HISTORY_MAX_RETRIES = 3;
const DELEGATE_HISTORY_RETRY_DELAY_MS = 250;

export interface DelegateHistoryRefreshCoordinator {
  markSettled(runIds: readonly string[]): void;
  observe(runIds: ReadonlySet<string>): void;
  refresh(): void;
  dispose(): void;
}

/** Refresh durable history a bounded number of times after live settlement. */
export function createDelegateHistoryRefreshCoordinator(
  refresh: () => void,
  options: {
    maxRetries?: number;
    retryDelayMs?: number;
  } = {},
): DelegateHistoryRefreshCoordinator {
  const pending = new Map<string, number>();
  const maxRetries = options.maxRetries ?? DELEGATE_HISTORY_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DELEGATE_HISTORY_RETRY_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (disposed || timer !== undefined || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || pending.size === 0) return;
      let shouldRefresh = false;
      for (const [runId, attempt] of pending) {
        if (attempt >= maxRetries) {
          pending.delete(runId);
          continue;
        }
        pending.set(runId, attempt + 1);
        shouldRefresh = true;
      }
      if (shouldRefresh) refresh();
      schedule();
    }, retryDelayMs);
  };

  return {
    markSettled(runIds) {
      if (disposed) return;
      let added = false;
      for (const runId of runIds) {
        if (!pending.has(runId)) {
          pending.set(runId, 0);
          added = true;
        }
      }
      if (added) refresh();
      schedule();
    },
    observe(runIds) {
      if (disposed) return;
      for (const runId of runIds) pending.delete(runId);
      if (pending.size === 0) clearTimer();
    },
    refresh() {
      if (!disposed) refresh();
    },
    dispose() {
      disposed = true;
      pending.clear();
      clearTimer();
    },
  };
}

export function delegateHistoryRevisionChanged(
  previous: { id: string; revision: number } | undefined,
  current: { id: string; revision: number },
): boolean {
  return (
    previous !== undefined &&
    previous.id === current.id &&
    previous.revision !== current.revision
  );
}

/**
 * The session-owned delegate surface composes durable history with the
 * optional runtime projection. It deliberately lives outside the live store.
 */
export function DelegateHistorySurface({
  id,
  runtime,
  sessionChange,
  store,
}: {
  id: string;
  runtime: RuntimeSnapshot | undefined;
  sessionChange: number;
  store: DashboardLiveStore;
}) {
  const historyQuery = useQuery(
    delegateHistoryQueryOptions(dashboardHttpClient, id),
  );
  const queryClient = useQueryClient();
  const sessionSyncGeneration = useDashboardStore(
    store,
    (state) => state.sessionSyncById[id]?.generation ?? 0,
  );
  const serverId = useDashboardStore(store, (state) => state.serverId);
  const live = delegateSurface(runtime);
  const liveRows = live?.model.statuses ?? [];
  const activeRows = liveRows.filter((row) =>
    isActiveDelegateState(row.state, row.pauseState),
  );
  const activeTranscriptQuery = useQuery({
    ...activeDelegateTranscriptQueryOptions(dashboardHttpClient, id),
    enabled: activeRows.length > 0,
  });
  const baseline = activeDelegateTranscriptBaselineFor(
    activeTranscriptQuery.data,
    {
      sessionId: id,
      serverId,
      runtimeId: runtime?.runtimeId,
      fetching: activeTranscriptQuery.isFetching,
    },
  );
  const baselineRows = overlayActiveDelegateTranscripts(liveRows, baseline);
  const baselineMissingRef = useRef('');
  useEffect(() => {
    if (!baseline) return;
    const baselineRuns = new Set(
      baseline.runs.map((run) => `${run.lineageId}:${run.runId}`),
    );
    const missing = activeRows
      .filter((row) => !baselineRuns.has(`${row.lineageId}:${row.runId}`))
      .map((row) => `${row.lineageId}:${row.runId}`)
      .sort()
      .join('|');
    if (!missing) {
      baselineMissingRef.current = '';
      return;
    }
    const missingKey = `${id}:${missing}`;
    if (missingKey === baselineMissingRef.current) return;
    baselineMissingRef.current = missingKey;
    void queryClient.invalidateQueries({
      queryKey: dashboardQueryKeys.activeDelegateTranscripts(id),
    });
  }, [activeRows, baseline, id, queryClient]);
  const previousRecovery = useRef({
    serverId,
    sessionSyncGeneration,
    sessionChange,
  });
  useEffect(() => {
    const previous = previousRecovery.current;
    previousRecovery.current = {
      serverId,
      sessionSyncGeneration,
      sessionChange,
    };
    if (
      previous.serverId === serverId &&
      previous.sessionSyncGeneration === sessionSyncGeneration &&
      previous.sessionChange === sessionChange
    )
      return;
    void queryClient.invalidateQueries({
      queryKey: dashboardQueryKeys.activeDelegateTranscripts(id),
    });
  }, [id, queryClient, serverId, sessionChange, sessionSyncGeneration]);
  useEffect(() => {
    if (activeRows.length === 0) return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.activeDelegateTranscripts(id),
      });
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [activeRows.length, id, queryClient]);
  const [detailSelection, setDetailSelection] = useState<{
    sessionId: string;
    lineageId: string;
    runId: string;
    shouldFetch: boolean;
  }>();
  const summaryLeafId = historyQuery.data?.leafId;
  const selectionOwnerMatches = detailSelection?.sessionId === id;
  const selectedLiveRunExists = Boolean(
    selectionOwnerMatches &&
      detailSelection &&
      liveRows.some(
        (row) =>
          row.lineageId === detailSelection.lineageId &&
          row.runId === detailSelection.runId,
      ),
  );
  const selectedPersistedRunExists = Boolean(
    selectionOwnerMatches &&
      detailSelection &&
      historyQuery.data?.groups.some((group) =>
        group.runs.some(
          (run) =>
            run.lineageId === detailSelection.lineageId &&
            run.runId === detailSelection.runId,
        ),
      ),
  );
  const selectedRunExists = selectedLiveRunExists || selectedPersistedRunExists;
  // React Query retains the previous summary while a scoped refresh is in
  // flight. Do not let that previous leaf authorize a detail request or an
  // inspector payload while its replacement is being fetched.
  const currentDetailSelection =
    selectionOwnerMatches && selectedRunExists && !historyQuery.isFetching
      ? detailSelection
      : undefined;
  const detailOptions = delegateHistoryRunQueryOptions(
    dashboardHttpClient,
    id,
    currentDetailSelection?.lineageId ?? '',
    currentDetailSelection?.runId ?? '',
    summaryLeafId,
  );
  const detailQuery = useQuery({
    ...detailOptions,
    // Live overlays and live-only rows already own their current transcript.
    // Persisted terminal summary rows are the only rows that load details.
    enabled: currentDetailSelection?.shouldFetch === true,
  });
  const previousStates = useRef(new Map<string, string>());
  const previousSessionId = useRef<string | undefined>(undefined);
  const previousSessionChange = useRef<
    { id: string; revision: number } | undefined
  >(undefined);
  const refreshCoordinator = useMemo(
    () =>
      createDelegateHistoryRefreshCoordinator(() => {
        void queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.delegateHistory(id),
        });
      }),
    [id, queryClient],
  );
  useEffect(() => () => refreshCoordinator.dispose(), [refreshCoordinator]);
  useEffect(() => {
    if (!detailSelection) return;
    // Keep the selected run stable across history-leaf hydration. The current
    // summary still reauthorizes it before detail is shown or requested.
    if (
      shouldClearDelegateDetailSelection({
        ownerMatches: detailSelection.sessionId === id,
        fetching: historyQuery.isFetching,
        runExists: selectedRunExists,
      })
    )
      setDetailSelection(undefined);
  }, [detailSelection, historyQuery.isFetching, id, selectedRunExists]);
  useEffect(() => {
    if (!detailSelection) return;
    const liveActive = liveRows.some(
      (row) =>
        row.runId === detailSelection.runId &&
        row.lineageId === detailSelection.lineageId &&
        isActiveDelegateState(row.state, row.pauseState),
    );
    // Once the selected run settles and the refreshed summary confirms its
    // stable identity, hydrate durable detail without requiring another click.
    if (
      shouldPromoteDelegateDetailSelection({
        shouldFetch: detailSelection.shouldFetch,
        ownerMatches: selectionOwnerMatches,
        fetching: historyQuery.isFetching,
        persistedRunExists: selectedPersistedRunExists,
        liveActive,
      })
    )
      setDetailSelection((current) =>
        current && !current.shouldFetch
          ? { ...current, shouldFetch: true }
          : current,
      );
  }, [
    detailSelection,
    historyQuery.isFetching,
    liveRows,
    selectedPersistedRunExists,
    selectionOwnerMatches,
  ]);
  useEffect(() => {
    const previous = previousSessionChange.current;
    const current = { id, revision: sessionChange };
    previousSessionChange.current = current;
    if (!delegateHistoryRevisionChanged(previous, current)) return;
    void queryClient.invalidateQueries({
      queryKey: dashboardQueryKeys.delegateHistory(id),
    });
    // A branch/session revision changes the durable authority for both the
    // summary and any selected-run payload. Settlement polling intentionally
    // invalidates only the summary key below, so cached details survive it.
    void queryClient.invalidateQueries({
      queryKey: dashboardQueryKeys.delegateHistoryDetail(id),
    });
  }, [id, queryClient, sessionChange]);
  useEffect(() => {
    if (previousSessionId.current !== id) {
      previousStates.current = new Map();
      previousSessionId.current = id;
    }
    // A queued launch is already present in durable history, but it does not
    // prove that a live settlement was persisted. Only terminal history rows
    // satisfy the refresh coordinator; otherwise the launch masks retries.
    const historySettledRunIds = delegateHistorySettledRunIds(
      historyQuery.data,
    );
    refreshCoordinator.observe(historySettledRunIds);
    const reconciliation = reconcileDelegateLiveRuns(
      id,
      previousStates.current,
      liveRows,
    );
    previousStates.current = reconciliation.next;
    const unresolvedSettlements = reconciliation.settledRunIds.filter(
      (runId) => !historySettledRunIds.has(runId),
    );
    refreshCoordinator.markSettled(unresolvedSettlements);
    if (reconciliation.shouldInvalidate && unresolvedSettlements.length === 0)
      refreshCoordinator.refresh();
  }, [id, liveRows, historyQuery.data, refreshCoordinator]);
  if (runtime?.pendingInteractions?.length) return null;
  const historyLoading = historyQuery.isPending && !historyQuery.data;
  const historyError = historyQuery.isError && !historyQuery.data;
  if (
    !historyQuery.data?.groups.length &&
    !historyQuery.data?.truncated &&
    liveRows.length === 0 &&
    !historyLoading &&
    !historyError
  )
    return null;
  const surface =
    live?.surface ??
    ({
      id: 'delegate-history',
      rendererId: DELEGATE_RENDERER_ID,
      viewModel: { version: 1, statuses: [] },
    } satisfies ExtensionSurface);
  const renderedSurface =
    baseline === undefined || surface.rendererId !== DELEGATE_RENDERER_ID
      ? surface
      : {
          ...surface,
          viewModel: {
            ...(surface.viewModel as Record<string, unknown>),
            statuses: baselineRows,
          },
        };
  return (
    <section
      className="extension-surfaces delegate-history-surface"
      aria-label="Delegate history and live status"
    >
      <div className="extension-surface-slot">
        <DelegateSurface
          key={id}
          surface={renderedSurface}
          pausedAt={runtimePauseStatus(runtime)?.pausedAt}
          history={historyQuery.data}
          historyLoading={historyLoading}
          historyError={historyError ? historyQuery.error : undefined}
          store={store}
          onRunSelected={(run: DelegateCompositeRun) => {
            setDetailSelection({
              sessionId: id,
              lineageId: run.row.lineageId,
              runId: run.id,
              shouldFetch: shouldFetchDelegateDetail(run),
            });
          }}
          detail={
            currentDetailSelection?.shouldFetch
              ? {
                  run: detailQuery.data,
                  loading: detailQuery.isPending,
                  error: detailQuery.isError ? detailQuery.error : undefined,
                }
              : undefined
          }
        />
      </div>
    </section>
  );
}

function surfaceOrder(surface: ExtensionSurface): number {
  if (surface.rendererId === TASKS_RENDERER_ID) return 0;
  if (surface.rendererId === DELEGATE_RENDERER_ID) return 1;
  return 2;
}

export function ExtensionSurfaceStack({
  runtime,
  placement = 'main',
  excludeDelegate = false,
}: {
  runtime: RuntimeSnapshot | undefined;
  placement?: SurfacePlacement;
  excludeDelegate?: boolean;
}) {
  const surfaces = useMemo(
    () =>
      runtimeExtensionSurfaces(runtime)
        .filter((surface) => surface.rendererId !== PAUSE_RENDERER_ID)
        .filter(
          (surface) => surface.rendererId !== SETTLED_BACKGROUND_RENDERER_ID,
        )
        .filter(
          (surface) =>
            !excludeDelegate || surface.rendererId !== DELEGATE_RENDERER_ID,
        )
        .filter(
          (surface) =>
            dashboardSurfacePlacement(surface.placement) === placement ||
            (placement === 'composer' &&
              (surface.rendererId === TASKS_RENDERER_ID ||
                surface.rendererId === DELEGATE_RENDERER_ID)),
        )
        .sort((left, right) => surfaceOrder(left) - surfaceOrder(right)),
    [excludeDelegate, runtime, placement],
  );
  if (runtime?.pendingInteractions?.length) return null;
  if (!surfaces.length) return null;
  return (
    <section
      className="extension-surfaces"
      aria-label="Live extension surfaces"
    >
      {surfaces.map((surface) => {
        const context: DashboardRendererContext = {
          surfaceId: surface.id,
          rendererId: surface.rendererId,
          placement: surface.placement,
          pausedAt: runtimePauseStatus(runtime)?.pausedAt,
        };
        return (
          <div className="extension-surface-slot" key={surface.id}>
            {renderDashboardContribution(
              surface.rendererId,
              surface.viewModel,
              context,
            )}
          </div>
        );
      })}
    </section>
  );
}
