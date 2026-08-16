import type { DelegateWorkflowCoordinator } from '../../delegate/workflow-coordinator';
import {
  CapabilityRegistry,
  seedCapabilityRegistry,
} from './capability-registry-core';
import { InteractionBroker } from './interaction-broker';
import { LiveSurfaceHub } from './live-surfaces-core';

export type SessionScopeId = string;
export const DEFAULT_SESSION_SCOPE_ID = 'default';

/** Per-scope aggregate used by long-running extension services. */
export class PendingProcessAccounting {
  private readonly sources = new Map<object, number>();
  private total = 0;

  set(source: object, count: number): void {
    const previous = this.sources.get(source) ?? 0;
    const next = Math.max(0, Math.floor(count));
    if (next === previous) return;
    if (next === 0) this.sources.delete(source);
    else this.sources.set(source, next);
    this.total += next - previous;
  }

  count(): number {
    return this.total;
  }

  hasPending(): boolean {
    return this.total > 0;
  }

  clear(source?: object): void {
    if (source) {
      const previous = this.sources.get(source) ?? 0;
      this.sources.delete(source);
      this.total -= previous;
      return;
    }
    this.sources.clear();
    this.total = 0;
  }
}

export interface ScopedServices {
  readonly scopeId: SessionScopeId;
  readonly interactionBroker: InteractionBroker;
  readonly liveSurfaceHub: LiveSurfaceHub;
  readonly pendingProcesses: PendingProcessAccounting;
  readonly capabilities: CapabilityRegistry;
  /** Session-owned delegate workflow identity for extension integrations. */
  delegateWorkflow?: DelegateWorkflowCoordinator;
}

const scopedServicesKey = Symbol.for('pi.dashboard.scoped-runtime-services');
const scopedServicesGlobal = globalThis as typeof globalThis & {
  [scopedServicesKey]?: Map<SessionScopeId, ScopedServices>;
};

function registry(): Map<SessionScopeId, ScopedServices> {
  const existing = scopedServicesGlobal[scopedServicesKey];
  if (existing) return existing;
  const created = new Map<SessionScopeId, ScopedServices>();
  scopedServicesGlobal[scopedServicesKey] = created;
  return created;
}

function normalizedScope(scopeId?: SessionScopeId): SessionScopeId {
  return scopeId?.trim() || DEFAULT_SESSION_SCOPE_ID;
}

/** Read a host context's scope while keeping old lightweight test contexts valid. */
export function getSessionScopeId(ctx: {
  sessionManager?: { getSessionId?: () => string };
}): SessionScopeId {
  try {
    return normalizedScope(ctx.sessionManager?.getSessionId?.());
  } catch {
    return DEFAULT_SESSION_SCOPE_ID;
  }
}

/** Get the process-global bridge entry for one session scope. */
export function getScopedServices(
  scopeId: SessionScopeId = DEFAULT_SESSION_SCOPE_ID,
): ScopedServices {
  const id = normalizedScope(scopeId);
  const services = registry().get(id);
  if (services) return services;
  const created: ScopedServices = {
    scopeId: id,
    interactionBroker: new InteractionBroker(),
    liveSurfaceHub: new LiveSurfaceHub(),
    pendingProcesses: new PendingProcessAccounting(),
    capabilities: seedCapabilityRegistry(new CapabilityRegistry()),
  };
  registry().set(id, created);
  return created;
}

/**
 * Tear down exactly the generation supplied by the caller. A replacement using
 * the same id cannot be cleared by a late shutdown from the old generation.
 */
export function findScopedServices(
  scopeId: SessionScopeId,
): ScopedServices | undefined {
  return registry().get(normalizedScope(scopeId));
}

export function releaseScopedServices(
  scopeId: SessionScopeId,
  expected?: ScopedServices,
): boolean {
  const id = normalizedScope(scopeId);
  const current = registry().get(id);
  if (!current || (expected && current !== expected)) return false;
  current.interactionBroker.cancelAll();
  current.liveSurfaceHub.clearAll();
  current.pendingProcesses.clear();
  registry().delete(id);
  return true;
}

export function listScopedServiceIds(): SessionScopeId[] {
  return [...registry().keys()];
}
