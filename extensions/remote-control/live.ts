import {
  type ExtensionSurface,
  SETTLED_BACKGROUND_RENDERER_ID,
  SETTLED_BACKGROUND_SURFACE_ID,
  SettledBackgroundViewModelSchema,
} from '@pi-dashboard/extension-contributions';
import { createLiveSurfacePublisher } from '../shared/runtime/live-surface-publisher';
import type { SessionScopeId } from '../shared/runtime/scoped-services';

type WaitingSurface = { count: number; requestPending?: true };

const publisher = createLiveSurfacePublisher<WaitingSurface>({
  extensionId: 'remote-control',
  surfaceId: SETTLED_BACKGROUND_SURFACE_ID,
  rendererId: SETTLED_BACKGROUND_RENDERER_ID,
  viewModelSchema: SettledBackgroundViewModelSchema,
  invalidMessage: 'Settled background surface is invalid.',
  buildViewModel: (waiting) => ({ version: 1 as const, ...waiting }),
});

export function settledBackgroundSurface(
  count: number,
  requestPending = false,
): ExtensionSurface {
  return publisher.surface({
    count,
    ...(requestPending ? { requestPending: true as const } : {}),
  });
}

export function publishSettledBackground(
  count: number,
  scopeId?: SessionScopeId,
  requestPending = false,
): void {
  if (count > 0 || requestPending)
    publisher.publish(
      { count, ...(requestPending ? { requestPending: true as const } : {}) },
      scopeId,
    );
  else publisher.clear(scopeId);
}

export function clearSettledBackground(scopeId?: SessionScopeId): void {
  publisher.clear(scopeId);
}
