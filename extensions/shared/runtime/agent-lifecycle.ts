import { hasPendingProcesses } from './pending-processes';
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

/** Treat settlement as genuine only when no shared or caller-local work remains. */
export function isGenuineAgentSettlement(
  hasPendingLocalWork = false,
  scopeId?: SessionScopeId,
): boolean {
  return !hasPendingLocalWork && !hasPendingProcesses(scopeId);
}

/** Match a new idle user turn, excluding steering, follow-ups, and automation. */
export function beginsFreshUserTurn(
  event: AgentInputEvent,
  scopeId?: SessionScopeId,
): boolean {
  if (event.streamingBehavior !== undefined) return false;
  if (event.source === 'extension') {
    const dashboardTurn = consumeDashboardFreshUserTurn(scopeId);
    return dashboardTurn && !hasPendingProcesses(scopeId);
  }
  return !hasPendingProcesses(scopeId);
}
