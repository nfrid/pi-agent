import {
  dashboardHttpClient,
  dashboardQueryKeys,
  delegateHistoryQueryOptions,
  delegateHistoryRunQueryOptions,
} from '@pi-dashboard/client';
import {
  type ExtensionSurface,
  type ExtensionSurfacePlacement,
  tryParseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
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
import { TASKS_RENDERER_ID } from '../../../../extensions/tasks/contribution';
import {
  type DashboardRendererContext,
  renderDashboardContribution,
} from '../renderer-registry';
import type { DelegateCompositeRun } from './delegate-history';
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
      // Remove disappeared keys before the caller schedules invalidation. A
      // later render therefore cannot invalidate the same disappearance loop.
      next.delete(key);
      shouldInvalidate = true;
    }
  }
  return { next, shouldInvalidate, settledRunIds };
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
}: {
  id: string;
  runtime: RuntimeSnapshot | undefined;
  sessionChange: number;
}) {
  const historyQuery = useQuery(
    delegateHistoryQueryOptions(dashboardHttpClient, id),
  );
  const queryClient = useQueryClient();
  const live = delegateSurface(runtime);
  const liveRows = live?.model.statuses ?? [];
  const [detailSelection, setDetailSelection] = useState<{
    lineageId: string;
    runId: string;
    shouldFetch: boolean;
  }>();
  const detailSessionId = useRef(id);
  const detailOptions = delegateHistoryRunQueryOptions(
    dashboardHttpClient,
    id,
    detailSelection?.lineageId ?? '',
    detailSelection?.runId ?? '',
    historyQuery.data?.leafId,
  );
  const detailQuery = useQuery({
    ...detailOptions,
    // Live overlays and live-only rows already own their current transcript.
    // Persisted terminal summary rows are the only rows that load details.
    enabled: detailSelection?.shouldFetch === true,
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
    if (detailSessionId.current === id) return;
    detailSessionId.current = id;
    setDetailSelection(undefined);
  }, [id]);
  useEffect(() => {
    if (!detailSelection || detailSelection.shouldFetch) return;
    const liveCurrent = liveRows.some(
      (row) =>
        row.runId === detailSelection.runId &&
        row.lineageId === detailSelection.lineageId,
    );
    const persisted = historyQuery.data?.groups.some((group) =>
      group.runs.some(
        (run) =>
          run.runId === detailSelection.runId &&
          run.lineageId === detailSelection.lineageId,
      ),
    );
    // A live overlay may intentionally suppress a detail request. Once it is
    // gone and the summary still contains the stable run identity, load the
    // selected durable transcript without requiring another click.
    if (!liveCurrent && persisted)
      setDetailSelection((current) =>
        current && !current.shouldFetch
          ? { ...current, shouldFetch: true }
          : current,
      );
  }, [detailSelection, historyQuery.data, liveRows]);
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
    const historyRunIds = delegateHistoryRunIds(historyQuery.data);
    refreshCoordinator.observe(historyRunIds);
    const reconciliation = reconcileDelegateLiveRuns(
      id,
      previousStates.current,
      liveRows,
    );
    previousStates.current = reconciliation.next;
    const unresolvedSettlements = reconciliation.settledRunIds.filter(
      (runId) => !historyRunIds.has(runId),
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
  return (
    <section
      className="extension-surfaces delegate-history-surface"
      aria-label="Delegate history and live status"
    >
      <div className="extension-surface-slot">
        <DelegateSurface
          surface={surface}
          pausedAt={runtimePauseStatus(runtime)?.pausedAt}
          history={historyQuery.data}
          historyLoading={historyLoading}
          historyError={historyError ? historyQuery.error : undefined}
          onRunSelected={(run: DelegateCompositeRun) => {
            const hasLiveTranscript = Boolean(run.row.transcript?.length);
            setDetailSelection({
              lineageId: run.row.lineageId,
              runId: run.id,
              shouldFetch:
                run.persisted === true &&
                run.live !== true &&
                !hasLiveTranscript,
            });
          }}
          detail={
            detailSelection?.shouldFetch
              ? {
                  run: detailQuery.data,
                  loading: detailQuery.isPending,
                  error: detailQuery.error,
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
