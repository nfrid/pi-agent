import { hasPendingProcesses } from './pending-processes';
import {
  DEFAULT_SESSION_SCOPE_ID,
  type SessionScopeId,
} from './scoped-services';

const dashboardFreshTurnsKey = Symbol.for(
  'pi.dashboard.fresh-extension-user-turns',
);
const dashboardFreshTurnsGlobal = globalThis as typeof globalThis & {
  [dashboardFreshTurnsKey]?: Map<SessionScopeId, number>;
};

function freshTurns(): Map<SessionScopeId, number> {
  const existing = dashboardFreshTurnsGlobal[dashboardFreshTurnsKey];
  if (existing) return existing;
  const created = new Map<SessionScopeId, number>();
  dashboardFreshTurnsGlobal[dashboardFreshTurnsKey] = created;
  return created;
}

function normalizedScope(scopeId?: SessionScopeId): SessionScopeId {
  return scopeId?.trim() || DEFAULT_SESSION_SCOPE_ID;
}

function removeFreshTurn(scope: SessionScopeId): boolean {
  const turns = freshTurns();
  const registered = turns.get(scope) ?? 0;
  if (registered <= 0) return false;
  if (registered === 1) turns.delete(scope);
  else turns.set(scope, registered - 1);
  return true;
}

/** Mark one extension-sourced input as an external dashboard user prompt. */
export function markDashboardFreshUserTurn(
  scopeId?: SessionScopeId,
): () => void {
  const scope = normalizedScope(scopeId);
  const turns = freshTurns();
  turns.set(scope, (turns.get(scope) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    removeFreshTurn(scope);
  };
}

function consumeDashboardFreshUserTurn(scopeId?: SessionScopeId): boolean {
  return removeFreshTurn(normalizedScope(scopeId));
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
