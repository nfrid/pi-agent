import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { getSessionScopeId } from '../shared/runtime/scoped-services';
import { getPauseCoordinator, type PauseSnapshot } from './state';

export const PAUSE_REQUESTED_EVENT = 'runtime-pause:requested';
export const PAUSE_RESUMED_EVENT = 'runtime-pause:resumed';
export const FOREGROUND_DELEGATES_PAUSED_EVENT =
  'runtime-pause:foreground-delegates-paused';

export interface PauseControlEvent {
  scopeId: string;
  generation: number;
  delegateIds: readonly string[];
}

export function requestRuntimePause(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): PauseSnapshot {
  const scopeId = getSessionScopeId(ctx);
  const coordinator = getPauseCoordinator(scopeId);
  const wasActive = coordinator.isActive();
  const snapshot = coordinator.request();
  if (!wasActive)
    pi.events.emit(PAUSE_REQUESTED_EVENT, {
      scopeId,
      generation: snapshot.generation,
      delegateIds: snapshot.delegateIds,
    } satisfies PauseControlEvent);
  if (ctx.isIdle()) coordinator.markMainReached(snapshot.generation);
  return coordinator.snapshot() as PauseSnapshot;
}

export function resumeRuntimePause(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): PauseSnapshot | undefined {
  const scopeId = getSessionScopeId(ctx);
  const coordinator = getPauseCoordinator(scopeId);
  const snapshot = coordinator.snapshot();
  if (!snapshot) return undefined;
  const resumed = coordinator.resume();
  pi.events.emit(PAUSE_RESUMED_EVENT, {
    scopeId,
    generation: snapshot.generation,
    delegateIds: snapshot.delegateIds,
  } satisfies PauseControlEvent);
  return resumed;
}
