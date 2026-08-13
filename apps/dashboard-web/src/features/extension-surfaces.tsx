import {
  dashboardHttpClient,
  dashboardQueryKeys,
  delegateHistoryQueryOptions,
} from '@pi-dashboard/client';
import {
  type ExtensionSurface,
  type ExtensionSurfacePlacement,
  tryParseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
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
): { next: Map<string, string>; shouldInvalidate: boolean } {
  const next = new Map(previous);
  const currentKeys = new Set<string>();
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
    )
      shouldInvalidate = true;
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
  return { next, shouldInvalidate };
}

/**
 * The session-owned delegate surface composes durable history with the
 * optional runtime projection. It deliberately lives outside the live store.
 */
export function DelegateHistorySurface({
  id,
  runtime,
}: {
  id: string;
  runtime: RuntimeSnapshot | undefined;
}) {
  const historyQuery = useQuery(
    delegateHistoryQueryOptions(dashboardHttpClient, id),
  );
  const queryClient = useQueryClient();
  const live = delegateSurface(runtime);
  const liveRows = live?.model.statuses ?? [];
  const previousStates = useRef(new Map<string, string>());
  useEffect(() => {
    const reconciliation = reconcileDelegateLiveRuns(
      id,
      previousStates.current,
      liveRows,
    );
    previousStates.current = reconciliation.next;
    if (reconciliation.shouldInvalidate)
      void queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.delegateHistory(id),
      });
  }, [id, liveRows, queryClient]);
  if (runtime?.pendingInteractions?.length) return null;
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
