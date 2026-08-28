import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { Value } from 'typebox/value';
import {
  DELEGATE_RENDERER_ID,
  type DelegateStatusViewModel,
  DelegateStatusViewModelSchema,
} from '../../../../../extensions/delegate/contribution';
import type { DashboardRendererContext } from '../../renderer-contract';
import { renderDashboardContribution } from '../../renderer-registry';
import { delegateSettlementKey } from './settlement-key';
import { runtimeExtensionSurfaces } from './surface-model';

export {
  dashboardSurfacePlacement,
  runtimeExtensionSurfaces,
  runtimePauseStatus,
  type SurfacePlacement,
} from './surface-model';

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

export { delegateSettlementKey } from './settlement-key';

/** Reconcile one session's live run keys without retaining removed overlays. */
export function reconcileDelegateLiveRuns(
  sessionId: string,
  previous: ReadonlyMap<string, string>,
  liveRows: readonly Pick<
    DelegateStatusViewModel['statuses'][number],
    'runId' | 'lineageId' | 'workflow' | 'state' | 'pauseState'
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
    const settlementKey = delegateSettlementKey(row);
    const key = `${sessionId}:${settlementKey}`;
    currentKeys.add(key);
    const prior = next.get(key);
    const current = row.pauseState ?? row.state;
    if (
      prior &&
      isActiveDelegateState(prior) &&
      !isActiveDelegateState(current)
    ) {
      shouldInvalidate = true;
      settledRunIds.push(settlementKey);
    }
    next.set(key, current);
  }
  for (const key of next.keys()) {
    if (!key.startsWith(`${sessionId}:`)) {
      next.delete(key);
      continue;
    }
    if (!currentKeys.has(key)) {
      const prior = next.get(key);
      if (prior !== undefined && !isActiveDelegateState(prior))
        settledRunIds.push(key.slice(`${sessionId}:`.length));
      next.delete(key);
      shouldInvalidate = true;
    }
  }
  return { next, shouldInvalidate, settledRunIds };
}

export function shouldFetchDelegateDetail(
  run: Pick<
    import('./history-compose').DelegateCompositeRun,
    'persisted' | 'live' | 'row'
  >,
): boolean {
  if (run.persisted !== true) return false;
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

export { delegateSurface, isActiveDelegateState };
