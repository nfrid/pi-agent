import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import { createLiveSurfacePublisher } from '../shared/runtime/live-surface-publisher';
import type { SessionScopeId } from '../shared/runtime/scoped-services';
import {
  PAUSE_RENDERER_ID,
  PAUSE_SURFACE_ID,
  PauseStatusViewModelSchema,
} from './contribution';
import { type PauseSnapshot, pauseLabel } from './state';

const publisher = createLiveSurfacePublisher<PauseSnapshot>({
  extensionId: 'pause',
  surfaceId: PAUSE_SURFACE_ID,
  rendererId: PAUSE_RENDERER_ID,
  placement: 'composer',
  viewModelSchema: PauseStatusViewModelSchema,
  invalidMessage: 'Pause status surface is invalid.',
  buildViewModel: (snapshot) => ({
    version: 1 as const,
    phase: snapshot.phase,
    delegateCount: snapshot.delegateIds.length,
    label: snapshot.phase === 'paused' ? pauseLabel(snapshot) : 'Pausing…',
  }),
});

export function pauseSurface(snapshot: PauseSnapshot): ExtensionSurface {
  return publisher.surface(snapshot);
}

export function publishPauseSurface(
  snapshot: PauseSnapshot,
  scopeId?: SessionScopeId,
): void {
  publisher.publish(snapshot, scopeId);
}

export function clearPauseSurface(scopeId?: SessionScopeId): void {
  publisher.clear(scopeId);
}
