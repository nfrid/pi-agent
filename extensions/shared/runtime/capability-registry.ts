import type {
  ExtensionCapabilityContract,
  ExtensionManifest,
  RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import {
  type CapabilityRegistry,
  globalCapabilityCatalog,
} from './capability-registry-core';
import {
  DEFAULT_SESSION_SCOPE_ID,
  getScopedServices,
  listScopedServiceIds,
  type SessionScopeId,
} from './scoped-services';

export {
  CapabilityRegistry,
  seedCapabilityRegistry,
} from './capability-registry-core';

/** Install or replace a contribution for every current and future session scope. */
export function registerExtensionCapability(
  contribution: ExtensionCapabilityContract,
): void {
  globalCapabilityCatalog().set(contribution.id, contribution);
  for (const scopeId of listScopedServiceIds())
    getScopedServices(scopeId).capabilities.register(contribution);
  // Ensure the default scope exists and receives the contract even when no
  // session has opened yet (unit tests and early hello snapshots).
  getScopedServices(DEFAULT_SESSION_SCOPE_ID).capabilities.register(
    contribution,
  );
}

export function unregisterExtensionCapability(id: string): void {
  globalCapabilityCatalog().delete(id);
  for (const scopeId of listScopedServiceIds())
    getScopedServices(scopeId).capabilities.unregister(id);
}

export function listRegisteredCapabilityIds(): string[] {
  return [...globalCapabilityCatalog().keys()];
}

export function getCapabilityRegistry(
  scopeId: SessionScopeId = DEFAULT_SESSION_SCOPE_ID,
): CapabilityRegistry {
  return getScopedServices(scopeId).capabilities;
}

export function aggregateRuntimeCapabilities(
  scopeId: SessionScopeId = DEFAULT_SESSION_SCOPE_ID,
): RuntimeCapabilitySnapshot {
  return getCapabilityRegistry(scopeId).snapshot();
}

export function contributionManifests(
  scopeId: SessionScopeId = DEFAULT_SESSION_SCOPE_ID,
): readonly ExtensionManifest[] {
  return getCapabilityRegistry(scopeId).manifests();
}
