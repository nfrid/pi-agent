import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMemo } from 'react';
import { DELEGATE_RENDERER_ID } from '../../../../../extensions/delegate/contribution';
import { PAUSE_RENDERER_ID } from '../../../../../extensions/pause/contribution';
import { SETTLED_BACKGROUND_RENDERER_ID } from '../../../../../extensions/remote-control/contribution';
import { TASKS_RENDERER_ID } from '../../../../../extensions/tasks/contribution';
import type { DashboardRendererContext } from '../../renderer-contract';
import { renderDashboardContribution } from '../../renderer-registry';
import {
  dashboardSurfacePlacement,
  runtimeExtensionSurfaces,
  runtimePauseStatus,
  type SurfacePlacement,
} from './surface-model';

function surfaceOrder(surface: ExtensionSurface): number {
  if (surface.rendererId === TASKS_RENDERER_ID) return 0;
  if (surface.rendererId === DELEGATE_RENDERER_ID) return 1;
  return 2;
}

export function ExtensionSurfaceStack({
  runtime,
  placement = 'main',
  excludeDelegate = false,
  slotsOnly = false,
}: {
  runtime: RuntimeSnapshot | undefined;
  placement?: SurfacePlacement;
  excludeDelegate?: boolean;
  slotsOnly?: boolean;
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
  if (!surfaces.length) return null;
  const slots = surfaces.map((surface) => {
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
  });
  return slotsOnly ? (
    slots
  ) : (
    <section
      className="extension-surfaces"
      aria-label="Live extension surfaces"
    >
      {slots}
    </section>
  );
}
