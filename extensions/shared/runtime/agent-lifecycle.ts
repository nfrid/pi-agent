import { hasPendingProcesses } from './pending-processes';
import type { SessionScopeId } from './scoped-services';

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
  return (
    event.source !== 'extension' &&
    event.streamingBehavior === undefined &&
    !hasPendingProcesses(scopeId)
  );
}
