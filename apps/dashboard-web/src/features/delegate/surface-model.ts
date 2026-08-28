import {
  type ExtensionSurface,
  type ExtensionSurfacePlacement,
  PAUSE_RENDERER_ID,
  type PauseStatusViewModel,
  PauseStatusViewModelSchema,
  tryParseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { Value } from 'typebox/value';

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
