import {
  DEFAULT_SESSION_SCOPE_ID,
  getScopedServices,
  type PendingProcessAccounting,
  type SessionScopeId,
} from './scoped-services';

/** Update one manager's contribution within one session scope. */
export function setPendingProcessCount(
  source: object,
  count: number,
  scopeId: SessionScopeId = DEFAULT_SESSION_SCOPE_ID,
  accounting?: PendingProcessAccounting,
): void {
  (accounting ?? getScopedServices(scopeId).pendingProcesses).set(
    source,
    count,
  );
}

export function pendingProcessCount(
  scopeId: SessionScopeId = DEFAULT_SESSION_SCOPE_ID,
): number {
  return getScopedServices(scopeId).pendingProcesses.count();
}

export function hasPendingProcesses(
  scopeId: SessionScopeId = DEFAULT_SESSION_SCOPE_ID,
): boolean {
  return pendingProcessCount(scopeId) > 0;
}
