import { getScopedServices, type SessionScopeId } from './scoped-services';

function removeFreshTurn(
  services: ReturnType<typeof getScopedServices>,
): boolean {
  if (services.freshDashboardUserTurns <= 0) return false;
  services.freshDashboardUserTurns -= 1;
  return true;
}

/** Mark one extension-sourced input as an external dashboard user prompt. */
export function markDashboardFreshUserTurn(
  scopeId?: SessionScopeId,
): () => void {
  const services = getScopedServices(scopeId);
  services.freshDashboardUserTurns += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    removeFreshTurn(services);
  };
}

function consumeDashboardFreshUserTurn(scopeId?: SessionScopeId): boolean {
  return removeFreshTurn(getScopedServices(scopeId));
}

export interface AgentInputEvent {
  source: 'interactive' | 'rpc' | 'extension';
  streamingBehavior?: 'steer' | 'followUp';
}

export function hasPendingRequestDependencies(
  scopeId?: SessionScopeId,
): boolean {
  return getScopedServices(scopeId).requestDependencies?.hasPending() ?? false;
}

/** Logical request dependencies, not passive process activity, delay settlement. */
export function isGenuineAgentSettlement(
  hasPendingLocalWork = false,
  scopeId?: SessionScopeId,
): boolean {
  const dependencies = getScopedServices(scopeId).requestDependencies;
  return !hasPendingLocalWork && !(dependencies?.hasPending() ?? false);
}

/** Match a new idle user turn, excluding steering, follow-ups, automation, and an open logical request. */
export function beginsFreshUserTurn(
  event: AgentInputEvent,
  scopeId?: SessionScopeId,
): boolean {
  if (event.streamingBehavior !== undefined) return false;
  const dashboardTurn =
    event.source === 'extension'
      ? consumeDashboardFreshUserTurn(scopeId)
      : false;
  if (getScopedServices(scopeId).requestDependencies?.hasPending())
    return false;
  return event.source === 'extension' ? dashboardTurn : true;
}
