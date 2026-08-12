export type PausePhase = 'pausing' | 'paused';

export interface PauseSnapshot {
  generation: number;
  phase: PausePhase;
  mainReached: boolean;
  delegateIds: readonly string[];
  reachedDelegateIds: readonly string[];
}

type Listener = (snapshot: PauseSnapshot | undefined) => void;

export class PauseCoordinator {
  private generation = 0;
  private active = false;
  private mainReached = false;
  private readonly delegates = new Set<string>();
  private readonly reachedDelegates = new Set<string>();
  private release: (() => void) | undefined;
  private releasePromise: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  snapshot(): PauseSnapshot | undefined {
    if (!this.active) return undefined;
    return {
      generation: this.generation,
      phase: this.isFullyPaused() ? 'paused' : 'pausing',
      mainReached: this.mainReached,
      delegateIds: [...this.delegates],
      reachedDelegateIds: [...this.reachedDelegates],
    };
  }

  request(): PauseSnapshot {
    if (!this.active) {
      this.active = true;
      this.generation++;
      this.mainReached = false;
      this.delegates.clear();
      this.reachedDelegates.clear();
      this.releasePromise = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      this.changed();
    }
    return this.snapshot() as PauseSnapshot;
  }

  enrollDelegates(generation: number, ids: readonly string[]): void {
    if (!this.matches(generation)) return;
    for (const id of ids) this.delegates.add(id);
    this.changed();
  }

  removeDelegate(generation: number, id: string): void {
    if (!this.matches(generation)) return;
    this.delegates.delete(id);
    this.reachedDelegates.delete(id);
    this.changed();
  }

  markMainReached(generation = this.generation): void {
    if (!this.matches(generation) || this.mainReached) return;
    this.mainReached = true;
    this.changed();
  }

  markDelegateReached(generation: number, id: string): void {
    if (!this.matches(generation) || !this.delegates.has(id)) return;
    this.reachedDelegates.add(id);
    this.changed();
  }

  async waitForResume(generation = this.generation): Promise<void> {
    if (!this.matches(generation)) return;
    this.markMainReached(generation);
    await this.releasePromise;
  }

  resume(): PauseSnapshot | undefined {
    const previous = this.snapshot();
    if (!previous) return undefined;
    const release = this.release;
    this.active = false;
    this.mainReached = false;
    this.delegates.clear();
    this.reachedDelegates.clear();
    this.release = undefined;
    this.releasePromise = Promise.resolve();
    release?.();
    this.changed();
    return previous;
  }

  isActive(): boolean {
    return this.active;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private matches(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private isFullyPaused(): boolean {
    return (
      this.mainReached && this.reachedDelegates.size === this.delegates.size
    );
  }

  private changed(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

const pauseCoordinatorsKey = Symbol.for('pi.runtime-pause.coordinators');
const pauseCoordinatorGlobal = globalThis as typeof globalThis & {
  [pauseCoordinatorsKey]?: Map<string, PauseCoordinator>;
};

function coordinatorRegistry(): Map<string, PauseCoordinator> {
  const existing = pauseCoordinatorGlobal[pauseCoordinatorsKey];
  if (existing) return existing;
  const created = new Map<string, PauseCoordinator>();
  pauseCoordinatorGlobal[pauseCoordinatorsKey] = created;
  return created;
}

export function getPauseCoordinator(scopeId: string): PauseCoordinator {
  const coordinators = coordinatorRegistry();
  const existing = coordinators.get(scopeId);
  if (existing) return existing;
  const created = new PauseCoordinator();
  coordinators.set(scopeId, created);
  return created;
}

export function releasePauseCoordinator(scopeId: string): void {
  const coordinators = coordinatorRegistry();
  const coordinator = coordinators.get(scopeId);
  coordinator?.resume();
  coordinators.delete(scopeId);
}

export function pauseLabel(snapshot: PauseSnapshot): string {
  const count = snapshot.delegateIds.length;
  return count > 0 ? `Paused (with ${count} delegates)` : 'Paused';
}
