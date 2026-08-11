import { asCapabilityActionHost } from '../shared/runtime/capability-action-host';
import { registerExtensionCapability } from '../shared/runtime/capability-registry';
import {
  ASK_USER_ANSWER_ACTION_ID,
  ASK_USER_CANCEL_ACTION_ID,
  askUserCapabilitySnapshot,
  askUserManifest,
} from './contribution';

let registered = false;

/** Publish ask-user contribution contracts into the session capability registry. */
export function registerAskUserCapability(): void {
  if (registered) return;
  registered = true;
  registerExtensionCapability({
    id: askUserManifest.id,
    manifest: askUserManifest,
    capabilities: askUserCapabilitySnapshot.capabilities,
    actionHandlers: {
      [ASK_USER_ANSWER_ACTION_ID]: (invocation, hostContext) => {
        const host = asCapabilityActionHost(hostContext);
        if (!host)
          throw Object.assign(new Error('Ask-user host context is missing.'), {
            code: 'unavailable-action',
          });
        const input = invocation.input as {
          interactionId: string;
          answer: string;
        };
        if (!host.broker.answer(input.interactionId, input.answer))
          throw Object.assign(
            new Error(
              'Interaction is already resolved or the answer is invalid.',
            ),
            { code: 'unavailable-action' },
          );
        return { accepted: true, actionId: invocation.actionId };
      },
      [ASK_USER_CANCEL_ACTION_ID]: (invocation, hostContext) => {
        const host = asCapabilityActionHost(hostContext);
        if (!host)
          throw Object.assign(new Error('Ask-user host context is missing.'), {
            code: 'unavailable-action',
          });
        const input = invocation.input as { interactionId: string };
        if (!host.broker.cancel(input.interactionId))
          throw Object.assign(new Error('Interaction is already resolved.'), {
            code: 'unavailable-action',
          });
        return { accepted: true, actionId: invocation.actionId };
      },
    },
  });
}
