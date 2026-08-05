import type { RuntimeExtensionSurface } from '../../../packages/dashboard-protocol/src/index';

/** The bridge keeps the aggregate surface catalogue bounded. */
export const MAX_LIVE_EXTENSION_SURFACES = 64;
export const MAX_LIVE_EXTENSION_SURFACES_PER_EXTENSION = 32;

export type LiveSurfaceListener = (
  surfaces: readonly RuntimeExtensionSurface[],
) => void;

export interface LiveSurfacePublisher {
  publish(
    extensionId: string,
    surfaces: readonly RuntimeExtensionSurface[],
  ): void;
  clear(extensionId: string): void;
  snapshot(): readonly RuntimeExtensionSurface[];
  subscribe(listener: LiveSurfaceListener): () => void;
}

function sameSurfaceList(
  left: readonly RuntimeExtensionSurface[],
  right: readonly RuntimeExtensionSurface[],
): boolean {
  return (
    left.length === right.length &&
    left.every((surface, index) => surface === right[index])
  );
}

/**
 * Small in-process handoff between extensions and the dashboard bridge.
 * Extensions own the surface values; the publisher only owns source slots and
 * lifecycle, so neither side needs to import the other's implementation.
 */
export class LiveSurfaceHub implements LiveSurfacePublisher {
  private readonly sources = new Map<
    string,
    readonly RuntimeExtensionSurface[]
  >();
  private readonly listeners = new Set<LiveSurfaceListener>();

  publish(
    extensionId: string,
    surfaces: readonly RuntimeExtensionSurface[],
  ): void {
    if (!extensionId) throw new Error('Live surface extension ID is required.');
    const bounded = surfaces.slice(
      0,
      MAX_LIVE_EXTENSION_SURFACES_PER_EXTENSION,
    );
    const previous = this.sources.get(extensionId) ?? [];
    if (sameSurfaceList(previous, bounded)) return;
    if (bounded.length > 0) this.sources.set(extensionId, bounded);
    else this.sources.delete(extensionId);
    this.notify();
  }

  clear(extensionId: string): void {
    if (!this.sources.delete(extensionId)) return;
    this.notify();
  }

  snapshot(): readonly RuntimeExtensionSurface[] {
    return [...this.sources.values()]
      .flat()
      .slice(0, MAX_LIVE_EXTENSION_SURFACES);
  }

  subscribe(listener: LiveSurfaceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const surfaces = this.snapshot();
    for (const listener of this.listeners) listener(surfaces);
  }
}

/** The one bridge-local publisher shared by extension registrations. */
export const liveExtensionSurfaceHub = new LiveSurfaceHub();
/** Short alias for callers that already know the hub is live-only. */
export const liveSurfaceHub = liveExtensionSurfaceHub;

export function publishLiveExtensionSurfaces(
  extensionId: string,
  surfaces: readonly RuntimeExtensionSurface[],
): void {
  liveExtensionSurfaceHub.publish(extensionId, surfaces);
}

export function clearLiveExtensionSurfaces(extensionId: string): void {
  liveExtensionSurfaceHub.clear(extensionId);
}
