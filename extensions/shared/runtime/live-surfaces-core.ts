import {
  type ExtensionSurface,
  MAX_EXTENSION_SURFACES,
  parseExtensionSurfaceList,
} from '@pi-dashboard/extension-contributions';

export const MAX_LIVE_EXTENSION_SURFACES = MAX_EXTENSION_SURFACES;
export const MAX_LIVE_EXTENSION_SURFACES_PER_EXTENSION = 32;

export type LiveSurfaceListener = (
  surfaces: readonly ExtensionSurface[],
) => void;

export interface LiveSurfacePublisher {
  publish(extensionId: string, surfaces: readonly ExtensionSurface[]): void;
  clear(extensionId: string): void;
  snapshot(): readonly ExtensionSurface[];
  subscribe(listener: LiveSurfaceListener): () => void;
}

function sameSurfaceList(
  left: readonly ExtensionSurface[],
  right: readonly ExtensionSurface[],
): boolean {
  return (
    left.length === right.length &&
    left.every((surface, index) => surface === right[index])
  );
}

/** Live extension surfaces owned by one session scope. */
export class LiveSurfaceHub implements LiveSurfacePublisher {
  private readonly sources = new Map<string, readonly ExtensionSurface[]>();
  private readonly listeners = new Set<LiveSurfaceListener>();

  publish(extensionId: string, surfaces: readonly ExtensionSurface[]): void {
    if (!extensionId) throw new Error('Live surface extension ID is required.');
    const bounded = surfaces.slice(
      0,
      MAX_LIVE_EXTENSION_SURFACES_PER_EXTENSION,
    );
    const previous = this.sources.get(extensionId) ?? [];
    if (sameSurfaceList(previous, bounded)) return;
    const prospective = [...this.sources.entries()].flatMap(
      ([source, values]) => (source === extensionId ? [] : values),
    );
    prospective.push(...bounded);
    parseExtensionSurfaceList(
      prospective.slice(0, MAX_LIVE_EXTENSION_SURFACES),
    );
    if (bounded.length > 0) this.sources.set(extensionId, bounded);
    else this.sources.delete(extensionId);
    this.notify();
  }

  clear(extensionId: string): void {
    if (!this.sources.delete(extensionId)) return;
    this.notify();
  }

  clearAll(): void {
    if (this.sources.size === 0) return;
    this.sources.clear();
    this.notify();
  }

  snapshot(): readonly ExtensionSurface[] {
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
