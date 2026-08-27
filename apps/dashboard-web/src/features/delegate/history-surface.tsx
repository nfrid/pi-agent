import {
  type DashboardLiveStore,
  dashboardHttpClient,
  dashboardQueryKeys,
  delegateHistoryQueryOptions,
  delegateHistoryRunQueryOptions,
} from '@pi-dashboard/client';
import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DELEGATE_RENDERER_ID } from '../../../../../extensions/delegate/contribution';
import { DelegateSurface } from '../surfaces/delegate-surface';
import {
  type DelegateCompositeRun,
  delegateHistorySettledRunIds,
} from './history-compose';
import {
  createDelegateHistoryRefreshCoordinator,
  delegateHistoryRevisionChanged,
} from './history-refresh';
import {
  delegateSurface,
  isActiveDelegateState,
  reconcileDelegateLiveRuns,
  runtimePauseStatus,
  shouldClearDelegateDetailSelection,
  shouldFetchDelegateDetail,
  shouldPromoteDelegateDetailSelection,
} from './runtime-surfaces';

export function DelegateHistorySurface({
  id,
  runtime,
  sessionChange,
  store,
  slotsOnly = false,
}: {
  id: string;
  runtime: RuntimeSnapshot | undefined;
  sessionChange: number;
  store: DashboardLiveStore;
  slotsOnly?: boolean;
}) {
  const historyQuery = useQuery(
    delegateHistoryQueryOptions(dashboardHttpClient, id),
  );
  const queryClient = useQueryClient();
  const live = delegateSurface(runtime);
  const liveRows = live?.model.statuses ?? [];
  const [detailSelection, setDetailSelection] = useState<{
    sessionId: string;
    lineageId: string;
    runId: string;
    liveRunId: string;
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
          row.runId === detailSelection.liveRunId,
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
        row.runId === detailSelection.liveRunId &&
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
  const historyLoading = historyQuery.isPending && !historyQuery.data;
  const historyError = historyQuery.isError && !historyQuery.data;
  if (
    !historyQuery.data?.groups.length &&
    !historyQuery.data?.truncated &&
    liveRows.length === 0
  )
    return null;
  const surface =
    live?.surface ??
    ({
      id: 'delegate-history',
      rendererId: DELEGATE_RENDERER_ID,
      viewModel: { version: 1, statuses: [] },
    } satisfies ExtensionSurface);
  const renderedSurface = surface;
  const slot = (
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
            liveRunId: run.row.runId,
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
  );
  return slotsOnly ? (
    slot
  ) : (
    <section
      className="extension-surfaces delegate-history-surface"
      aria-label="Delegate history and live status"
    >
      {slot}
    </section>
  );
}
