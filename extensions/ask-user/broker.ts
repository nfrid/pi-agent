import {
  getScopedServices,
  type SessionScopeId,
} from '../shared/runtime/scoped-services';

export {
  type BrokerChoice,
  type BrokerResult,
  type BrokerScope,
  DEFAULT_INTERACTION_TIMEOUT_MS,
  InteractionBroker,
  MAX_INTERACTION_TIMEOUT_MS,
  type PendingInteraction,
} from '../shared/runtime/interaction-broker';

/**
 * Compatibility facade for existing one-session callers. New callers should
 * pass the session manager's id so isolated extension graphs share only that
 * scope's broker.
 */
export function getInteractionBroker(
  scopeId: SessionScopeId = 'default',
): import('../shared/runtime/interaction-broker').InteractionBroker {
  return getScopedServices(scopeId).interactionBroker;
}
