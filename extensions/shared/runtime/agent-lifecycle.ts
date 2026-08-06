import { hasPendingProcesses } from './pending-processes';

export interface AgentInputEvent {
  source: 'interactive' | 'rpc' | 'extension';
  streamingBehavior?: 'steer' | 'followUp';
}

/** Treat settlement as genuine only when no shared or caller-local work remains. */
export function isGenuineAgentSettlement(hasPendingLocalWork = false): boolean {
  return !hasPendingLocalWork && !hasPendingProcesses();
}

/** Match a new idle user turn, excluding steering, follow-ups, and automation. */
export function beginsFreshUserTurn(event: AgentInputEvent): boolean {
  return (
    event.source !== 'extension' &&
    event.streamingBehavior === undefined &&
    !hasPendingProcesses()
  );
}
