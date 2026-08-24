import {
  type ExtensionSurface,
  type ExtensionSurfacePlacement,
  tryParseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import type {
  ActiveDelegateTranscriptBaseline,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { Value } from 'typebox/value';
import {
  DELEGATE_RENDERER_ID,
  type DelegateStatusViewModel,
  DelegateStatusViewModelSchema,
} from '../../../../../extensions/delegate/contribution';
import {
  PAUSE_RENDERER_ID,
  type PauseStatusViewModel,
  PauseStatusViewModelSchema,
} from '../../../../../extensions/pause/contribution';
import {
  type DashboardRendererContext,
  renderDashboardContribution,
} from '../../renderer-registry';

export type SurfacePlacement = 'main' | 'composer';

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

export function delegateSettlementKey(row: {
  runId: string;
  workflow?: { identity?: string };
}): string {
  const identity = row.workflow?.identity;
  return identity ? `workflow:${identity}` : row.runId;
}

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
