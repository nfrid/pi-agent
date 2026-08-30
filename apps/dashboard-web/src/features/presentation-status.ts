import {
  type ExtensionSurface,
  PAUSE_RENDERER_ID,
  type PauseStatusViewModel,
  PauseStatusViewModelSchema,
  SETTLED_BACKGROUND_RENDERER_ID,
  SettledBackgroundViewModelSchema,
  tryParseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { Value } from 'typebox/value';

export type DashboardPresentationStatus =
  | RuntimeSnapshot['liveState']
  | 'paused'
  | 'offline'
  | 'dormant'
  | 'input';

export type DashboardStatusPresentation = {
  status: DashboardPresentationStatus;
  label: string;
};

function runtimeSurfaces(
  runtime: RuntimeSnapshot | undefined,
): readonly ExtensionSurface[] {
  return (runtime?.extensionSurfaces ?? []).flatMap((surface) => {
    const parsed = tryParseExtensionSurface(surface);
    return parsed ? [parsed] : [];
  });
}

function pauseStatus(
  runtime: RuntimeSnapshot | undefined,
): PauseStatusViewModel | undefined {
  const surface = runtimeSurfaces(runtime).find(
    (candidate) => candidate.rendererId === PAUSE_RENDERER_ID,
  );
  return surface && Value.Check(PauseStatusViewModelSchema, surface.viewModel)
    ? (surface.viewModel as PauseStatusViewModel)
    : undefined;
}

/** Read the central settled-background transport surface. */
export function settledBackgroundCount(
  runtime: RuntimeSnapshot | undefined,
): number {
  const surface = runtimeSurfaces(runtime).find(
    (candidate) => candidate.rendererId === SETTLED_BACKGROUND_RENDERER_ID,
  );
  return surface &&
    Value.Check(SettledBackgroundViewModelSchema, surface.viewModel)
    ? (surface.viewModel as { count: number }).count
    : 0;
}

export function hasSettledBackground(
  runtime: RuntimeSnapshot | undefined,
): boolean {
  return settledBackgroundCount(runtime) > 0;
}

/** Derive compact dashboard labels without changing RuntimeLiveState. */
export function dashboardStatus(
  runtime: RuntimeSnapshot | undefined,
): DashboardStatusPresentation {
  if (!runtime) return { status: 'dormant', label: 'ready' };
  if (runtime.online === false) return { status: 'offline', label: 'offline' };

  const pause = pauseStatus(runtime);
  if (pause) return { status: 'paused', label: pause.label };

  const count = settledBackgroundCount(runtime);
  if (
    count > 0 &&
    (runtime.liveState === 'idle' || runtime.liveState === 'working')
  )
    return {
      status: 'waiting',
      label: count === 1 ? 'needs input' : `needs input · ${count}`,
    };
  if (runtime.liveState === 'idle') return { status: 'idle', label: 'ready' };
  return { status: runtime.liveState, label: runtime.liveState };
}
