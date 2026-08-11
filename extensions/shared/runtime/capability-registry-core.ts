import {
  createRuntimeCapabilitySnapshot,
  type ExtensionCapabilityActionHandler,
  type ExtensionCapabilityContract,
  type ExtensionManifest,
  findActionDescriptor,
  type RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';

const catalogKey = Symbol.for('pi.dashboard.capability-contribution-catalog');
const catalogGlobal = globalThis as typeof globalThis & {
  [catalogKey]?: Map<string, ExtensionCapabilityContract>;
};

/** Process-global contribution catalog shared by every session scope. */
export function globalCapabilityCatalog(): Map<
  string,
  ExtensionCapabilityContract
> {
  const existing = catalogGlobal[catalogKey];
  if (existing) return existing;
  const created = new Map<string, ExtensionCapabilityContract>();
  catalogGlobal[catalogKey] = created;
  return created;
}

/**
 * In-memory catalogue of extension contribution contracts for one session scope.
 */
export class CapabilityRegistry {
  private readonly byId = new Map<string, ExtensionCapabilityContract>();

  constructor(seed: readonly ExtensionCapabilityContract[] = []) {
    for (const contribution of seed)
      this.byId.set(contribution.id, contribution);
  }

  register(contribution: ExtensionCapabilityContract): void {
    this.byId.set(contribution.id, contribution);
  }

  unregister(id: string): boolean {
    return this.byId.delete(id);
  }

  get(id: string): ExtensionCapabilityContract | undefined {
    return this.byId.get(id);
  }

  list(): readonly ExtensionCapabilityContract[] {
    return [...this.byId.values()];
  }

  manifests(): readonly ExtensionManifest[] {
    return this.list().map((contribution) => contribution.manifest);
  }

  /** Aggregate advertised capabilities for hello / runtime snapshots. */
  snapshot(): RuntimeCapabilitySnapshot {
    const contributions = this.list();
    const capabilities = contributions.flatMap((contribution) => {
      const dynamic = contribution.snapshotProvider?.() ?? [];
      if (dynamic.length > 0) return [...dynamic];
      return [...(contribution.capabilities ?? [])];
    });
    return createRuntimeCapabilitySnapshot(
      contributions.map((contribution) => contribution.manifest),
      capabilities,
    );
  }

  findAction(actionId: string) {
    return findActionDescriptor([...this.manifests()], actionId);
  }

  findHandler(actionId: string): ExtensionCapabilityActionHandler | undefined {
    for (const contribution of this.byId.values()) {
      const handler = contribution.actionHandlers?.[actionId];
      if (handler) return handler;
    }
    return undefined;
  }
}

/** Seed a freshly created ScopedServices capabilities map from the catalog. */
export function seedCapabilityRegistry(
  registry: CapabilityRegistry,
): CapabilityRegistry {
  for (const contribution of globalCapabilityCatalog().values())
    registry.register(contribution);
  return registry;
}
