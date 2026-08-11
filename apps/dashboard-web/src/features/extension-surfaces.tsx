import {
  type ExtensionSurface,
  type ExtensionSurfacePlacement,
  tryParseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMemo } from 'react';
import { DELEGATE_RENDERER_ID } from '../../../../extensions/delegate/contribution';
import { TASKS_RENDERER_ID } from '../../../../extensions/tasks/contribution';
import {
  type DashboardRendererContext,
  renderDashboardContribution,
} from '../renderer-registry';

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

function surfaceOrder(surface: ExtensionSurface): number {
  if (surface.rendererId === TASKS_RENDERER_ID) return 0;
  if (surface.rendererId === DELEGATE_RENDERER_ID) return 1;
  return 2;
}

export function ExtensionSurfaceStack({
  runtime,
  placement = 'main',
}: {
  runtime: RuntimeSnapshot | undefined;
  placement?: SurfacePlacement;
}) {
  const surfaces = useMemo(
    () =>
      runtimeExtensionSurfaces(runtime)
        .filter(
          (surface) =>
            dashboardSurfacePlacement(surface.placement) === placement ||
            (placement === 'composer' &&
              (surface.rendererId === TASKS_RENDERER_ID ||
                surface.rendererId === DELEGATE_RENDERER_ID)),
        )
        .sort((left, right) => surfaceOrder(left) - surfaceOrder(right)),
    [runtime, placement],
  );
  if (runtime?.pendingInteractions?.length) return null;
  if (!surfaces.length) return null;
  return (
    <section
      className="extension-surfaces"
      aria-label="Live extension surfaces"
    >
      {surfaces.map((surface) => (
        <div className="extension-surface-slot" key={surface.id}>
          {renderLiveExtensionSurface(surface)}
        </div>
      ))}
    </section>
  );
}
