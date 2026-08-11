import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { InteractionBroker } from './interaction-broker';
import type { SessionScopeId } from './scoped-services';

/** Host bag passed to capability action handlers at dispatch time. */
export interface CapabilityActionHost {
  readonly scopeId: SessionScopeId;
  readonly broker: InteractionBroker;
  readonly ctx: ExtensionContext;
  readonly pi: ExtensionAPI;
}

export function asCapabilityActionHost(
  value: unknown,
): CapabilityActionHost | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<CapabilityActionHost>;
  if (
    typeof candidate.scopeId !== 'string' ||
    !candidate.broker ||
    !candidate.ctx ||
    !candidate.pi
  )
    return undefined;
  return candidate as CapabilityActionHost;
}
