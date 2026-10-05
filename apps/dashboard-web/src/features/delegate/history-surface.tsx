import {
  type DashboardHttpClient,
  type DashboardLiveStore,
  dashboardQueryKeys,
  delegateHistoryQueryOptions,
  delegateHistoryRunQueryOptions,
} from '@pi-dashboard/client';
import {
  DELEGATE_RENDERER_ID,
  type ExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DelegateSurface } from '../surfaces/delegate-surface';
import {
  type DelegateCompositeRun,
  delegateHistorySettledRunIds,
} from './history-compose';
import {
  createDelegateHistoryRefreshCoordinator,
  delegateHistoryPendingRunIds,
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
import { delegateSettlementKey } from './settlement-key';

type DelegateDetailSelection = {
  sessionId: string;
  lineageId: string;
  runId: string;
  liveRunId: string;
  settlementKey: string;
  leafId?: string;
  shouldFetch: boolean;
};

export function promoteDelegateDetailSelection(
  selection: DelegateDetailSelection,
  leafId: string | undefined,
): DelegateDetailSelection {
  return selection.shouldFetch
    ? selection
    : { ...selection, leafId, shouldFetch: true };
}

export function DelegateHistorySurface({
  id,
  runtime,
  sessionChange,
  store,
  client,
  slotsOnly = false,
  activityPanel = false,
}: {
  id: string;
  runtime: RuntimeSnapshot | undefined;
  sessionChange: number;
  store: DashboardLiveStore;
  client: DashboardHttpClient;
  slotsOnly?: boolean;
  activityPanel?: boolean;
}) {
  const historyQuery = useQuery(delegateHistoryQueryOptions(client, id));
  const queryClient = useQueryClient();
  const historySettledRunIds = useMemo(
    () => delegateHistorySettledRunIds(historyQuery.data),
    [historyQuery.data],
  );
  const live = delegateSurface(runtime);
  const liveRows = live?.model.statuses ?? [];
  const [detailSelection, setDetailSelection] =
    useState<DelegateDetailSelection>();
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
  // Keep detail authorized by the summary leaf that was current when the run
  // was selected. Transcript revisions can change the summary leaf without
  // changing that run's durable membership or its detail payload.
  const currentDetailSelection =
    selectionOwnerMatches && selectedRunExists ? detailSelection : undefined;
  const detailOptions = delegateHistoryRunQueryOptions(
    client,
    id,
    currentDetailSelection?.lineageId ?? '',
    currentDetailSelection?.runId ?? '',
    currentDetailSelection?.leafId,
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
  const [settlingState, setSettlingState] = useState<{
    sessionId: string;
    runIds: ReadonlySet<string>;
  }>();
  const settlingRunIds = delegateHistoryPendingRunIds(settlingState, id);
  const refreshCoordinator = useMemo(
    () =>
      createDelegateHistoryRefreshCoordinator(
        () => {
          const queryKey = dashboardQueryKeys.delegateHistory(id);
          return queryClient.invalidateQueries(
            { queryKey },
            { cancelRefetch: false },
          );
        },
        {
          onPendingChange: (runIds) =>
            setSettlingState({ sessionId: id, runIds }),
        },
      ),
    [id, queryClient],
  );
  useEffect(() => () => refreshCoordinator.dispose(), [refreshCoordinator]);
  useEffect(() => {
    refreshCoordinator.setFetching(historyQuery.isFetching);
  }, [historyQuery.isFetching, refreshCoordinator]);
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
    const durableTerminal =
      historySettledRunIds.has(detailSelection.settlementKey) ||
      historySettledRunIds.has(detailSelection.runId) ||
      historySettledRunIds.has(detailSelection.liveRunId);
    const liveActive =
      !durableTerminal &&
      liveRows.some(
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
        durableTerminal,
        liveActive,
      })
    )
      setDetailSelection((current) =>
        current
          ? promoteDelegateDetailSelection(current, summaryLeafId)
          : current,
      );
  }, [
    detailSelection,
    historyQuery.isFetching,
    historySettledRunIds,
    liveRows,
    selectedPersistedRunExists,
    selectionOwnerMatches,
    summaryLeafId,
  ]);
  useEffect(() => {
    const previous = previousSessionChange.current;
    const current = { id, revision: sessionChange };
    previousSessionChange.current = current;
    if (!delegateHistoryRevisionChanged(previous, current)) return;
    refreshCoordinator.refreshRevision();
  }, [id, refreshCoordinator, sessionChange]);
  useEffect(() => {
    if (previousSessionId.current !== id) {
      previousStates.current = new Map();
      previousSessionId.current = id;
    }
    // A queued launch is already present in durable history, but it does not
    // prove that a live settlement was persisted. Only terminal history rows
    // satisfy the refresh coordinator; otherwise the launch masks retries.
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
  }, [id, liveRows, historySettledRunIds, refreshCoordinator]);
  const historyLoading = historyQuery.isPending && !historyQuery.data;
  const historyError = historyQuery.isError && !historyQuery.data;
  if (
    !historyQuery.data?.groups.length &&
    !historyQuery.data?.truncated &&
    liveRows.length === 0 &&
    (!activityPanel || !historyError)
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
  const delegateSurfaceElement = (
    <DelegateSurface
      key={id}
      surface={renderedSurface}
      pausedAt={runtimePauseStatus(runtime)?.pausedAt}
      history={historyQuery.data}
      settlingRunIds={settlingRunIds}
      historyLoading={historyLoading}
      historyError={historyError ? historyQuery.error : undefined}
      store={store}
      client={client}
      activityPanel={activityPanel}
      onRunSelected={(run: DelegateCompositeRun) => {
        setDetailSelection({
          sessionId: id,
          lineageId: run.row.lineageId,
          runId: run.id,
          liveRunId: run.row.runId,
          settlementKey: delegateSettlementKey(run.row),
          leafId: summaryLeafId,
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
  );
  const slot = activityPanel ? (
    delegateSurfaceElement
  ) : (
    <div className="extension-surface-slot">{delegateSurfaceElement}</div>
  );
  return slotsOnly || activityPanel ? (
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
