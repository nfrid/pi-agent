import {
  DEFAULT_SESSION_SCOPE_ID,
  findScopedServices,
  getScopedServices,
  type SessionScopeId,
} from './scoped-services';

export {
  LiveSurfaceHub,
  type LiveSurfaceListener,
  type LiveSurfacePublisher,
  MAX_LIVE_EXTENSION_SURFACES,
  MAX_LIVE_EXTENSION_SURFACES_PER_EXTENSION,
} from './live-surfaces-core';

type Hub = import('./live-surfaces-core').LiveSurfaceHub;

// The no-argument facade always addresses the default scope for compatibility
// with older extension callers. Explicit scope lookups are always isolated.
const defaultHubFacade = {
  publish(extensionId: string, surfaces: Parameters<Hub['publish']>[1]): void {
    getScopedServices(DEFAULT_SESSION_SCOPE_ID).liveSurfaceHub.publish(
      extensionId,
      surfaces,
    );
  },
  clear(extensionId: string): void {
    getScopedServices(DEFAULT_SESSION_SCOPE_ID).liveSurfaceHub.clear(
      extensionId,
    );
  },
  clearAll(): void {
    getScopedServices(DEFAULT_SESSION_SCOPE_ID).liveSurfaceHub.clearAll();
  },
  snapshot(): ReturnType<Hub['snapshot']> {
    return getScopedServices(
      DEFAULT_SESSION_SCOPE_ID,
    ).liveSurfaceHub.snapshot();
  },
  subscribe(
    listener: Parameters<Hub['subscribe']>[0],
  ): ReturnType<Hub['subscribe']> {
    return getScopedServices(DEFAULT_SESSION_SCOPE_ID).liveSurfaceHub.subscribe(
      listener,
    );
  },
} as Hub;

/** Get a scope-specific hub, or the compatibility facade for one-session code. */
export function getLiveExtensionSurfaceHub(scopeId?: SessionScopeId): Hub {
  return scopeId === undefined
    ? defaultHubFacade
    : getScopedServices(scopeId).liveSurfaceHub;
}

export const liveExtensionSurfaceHub = getLiveExtensionSurfaceHub();
/** Short alias for callers that already know the hub is live-only. */
export const liveSurfaceHub = liveExtensionSurfaceHub;

export function publishLiveExtensionSurfaces(
  extensionId: string,
  surfaces: readonly import('@pi-dashboard/extension-contributions').ExtensionSurface[],
  scopeId: SessionScopeId = 'default',
): void {
  getScopedServices(scopeId).liveSurfaceHub.publish(extensionId, surfaces);
}

export function clearLiveExtensionSurfaces(
  extensionId: string,
  scopeId: SessionScopeId = 'default',
): void {
  findScopedServices(scopeId)?.liveSurfaceHub.clear(extensionId);
}

// Keep the pre-registry symbol visible to old isolated extension graphs.
const legacyLiveSurfaceKey = Symbol.for('pi.dashboard.live-extension-surfaces');
(globalThis as typeof globalThis & { [legacyLiveSurfaceKey]?: Hub })[
  legacyLiveSurfaceKey
] = liveExtensionSurfaceHub;
