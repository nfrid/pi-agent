import {
  type ExtensionSurface,
  SETTLED_BACKGROUND_RENDERER_ID,
  SETTLED_BACKGROUND_SURFACE_ID,
  SettledBackgroundViewModelSchema,
} from '@pi-dashboard/extension-contributions';
import { createLiveSurfacePublisher } from '../shared/runtime/live-surface-publisher';
import type { SessionScopeId } from '../shared/runtime/scoped-services';

const publisher = createLiveSurfacePublisher<number>({
  extensionId: 'remote-control',
  surfaceId: SETTLED_BACKGROUND_SURFACE_ID,
  rendererId: SETTLED_BACKGROUND_RENDERER_ID,
  viewModelSchema: SettledBackgroundViewModelSchema,
  invalidMessage: 'Settled background surface is invalid.',
  buildViewModel: (count) => ({ version: 1 as const, count }),
});

export function settledBackgroundSurface(count: number): ExtensionSurface {
  return publisher.surface(count);
}

export function publishSettledBackground(
  count: number,
  scopeId?: SessionScopeId,
): void {
  if (count > 0) publisher.publish(count, scopeId);
  else publisher.clear(scopeId);
}

export function clearSettledBackground(scopeId?: SessionScopeId): void {
  publisher.clear(scopeId);
}
