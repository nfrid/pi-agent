import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type ActionInvocation,
  findActionDescriptor,
  isActionAvailable,
  parseActionInput,
  parseActionInvocation,
  type RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import type { BridgeCommand } from '../../packages/dashboard-protocol/src/pi-runtime-protocol';
import { executeActivityGroupsAction } from '../activity-groups/actions';
import { ACTIVITY_GROUPS_ACTION_ID } from '../activity-groups/contribution';
import type { InteractionBroker } from '../ask-user/broker';
import {
  ASK_USER_ANSWER_ACTION_ID,
  ASK_USER_CANCEL_ACTION_ID,
} from '../ask-user/contribution';
import { dispatchDashboardInput } from './command-adapter';
import {
  RUNTIME_ABORT_ACTION_ID,
  RUNTIME_SHUTDOWN_ACTION_ID,
  SESSION_COMPACT_ACTION_ID,
} from './contribution';
import {
  isQueueDraftCommand,
  type QueueDraftStore,
  queueDraftError,
} from './queue-draft-store';
import {
  CONTRIBUTION_MANIFESTS,
  RUNTIME_CAPABILITIES,
} from './runtime-snapshot-adapter';

export type CommandHandler = (
  command: BridgeCommand,
  capabilities: RuntimeCapabilitySnapshot,
) => Promise<unknown>;

async function dispatchSemanticAction(
  ctx: ExtensionContext,
  broker: InteractionBroker,
  command: Extract<BridgeCommand, { type: 'action.invoke' }>,
  capabilities: RuntimeCapabilitySnapshot,
): Promise<unknown> {
  const invocation: ActionInvocation = parseActionInvocation(command);
  const action = findActionDescriptor(
    CONTRIBUTION_MANIFESTS,
    invocation.actionId,
  );
  const advertisedAction = capabilities.manifests
    .flatMap((manifest) => manifest.actions)
    .find((candidate) => candidate.id === invocation.actionId);
  if (!advertisedAction)
    throw Object.assign(
      new Error(`Unknown dashboard action: ${invocation.actionId}`),
      { code: 'unknown-action' },
    );
  if (!action)
    throw Object.assign(
      new Error(`No adapter for dashboard action: ${invocation.actionId}`),
      { code: 'unknown-action' },
    );
  const available = isActionAvailable(advertisedAction, capabilities, {
    online: true,
    liveState:
      broker.list().length > 0 ? 'waiting' : ctx.isIdle() ? 'idle' : 'working',
    pendingInteractions: broker.list().length,
  });
  if (!available)
    throw Object.assign(
      new Error(`Dashboard action is unavailable: ${invocation.actionId}`),
      { code: 'unavailable-action' },
    );
  parseActionInput(advertisedAction, invocation.input);
  if (invocation.actionId === ASK_USER_ANSWER_ACTION_ID) {
    const input = invocation.input as { interactionId: string; answer: string };
    if (!broker.answer(input.interactionId, input.answer))
      throw Object.assign(
        new Error('Interaction is already resolved or the answer is invalid.'),
        {
          code: 'unavailable-action',
        },
      );
    return { accepted: true, actionId: invocation.actionId };
  }
  if (invocation.actionId === ASK_USER_CANCEL_ACTION_ID) {
    const input = invocation.input as { interactionId: string };
    if (!broker.cancel(input.interactionId))
      throw Object.assign(new Error('Interaction is already resolved.'), {
        code: 'unavailable-action',
      });
    return { accepted: true, actionId: invocation.actionId };
  }
  if (invocation.actionId === ACTIVITY_GROUPS_ACTION_ID)
    return executeActivityGroupsAction(invocation.input);
  if (invocation.actionId === SESSION_COMPACT_ACTION_ID) {
    const input = invocation.input as { customInstructions?: string };
    await ctx.compact({
      customInstructions: input.customInstructions || undefined,
    });
    return { accepted: true, actionId: invocation.actionId };
  }
  if (invocation.actionId === RUNTIME_ABORT_ACTION_ID) {
    ctx.abort();
    return { accepted: true, actionId: invocation.actionId };
  }
  if (invocation.actionId === RUNTIME_SHUTDOWN_ACTION_ID) {
    ctx.shutdown();
    return { accepted: true, actionId: invocation.actionId };
  }
  throw Object.assign(
    new Error(`No adapter for dashboard action: ${invocation.actionId}`),
    {
      code: 'unknown-action',
    },
  );
}

export async function dispatchDashboardCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  broker: InteractionBroker,
  command: BridgeCommand,
  capabilities = RUNTIME_CAPABILITIES,
  queueDrafts?: QueueDraftStore,
): Promise<unknown> {
  if (command.type === 'action.invoke')
    return dispatchSemanticAction(ctx, broker, command, capabilities);
  if (isQueueDraftCommand(command)) {
    if (!queueDrafts)
      throw queueDraftError(
        'queue-drafts-unavailable',
        'Queue drafts are unavailable for this runtime.',
      );
    if (command.type === 'queue.add' || command.type === 'queueDraft.add')
      return { accepted: true, draft: queueDrafts.add(command) };
    if (command.type === 'queue.update' || command.type === 'queueDraft.update')
      return { accepted: true, draft: queueDrafts.update(command) };
    queueDrafts.remove(command.clientId);
    return { accepted: true, clientId: command.clientId };
  }
  switch (command.type) {
    case 'prompt':
      if (!ctx.isIdle())
        throw new Error('Agent is working; choose steer or follow-up.');
      if (command.images?.length && !ctx.model?.input.includes('image'))
        throw new Error('The selected model does not support image input.');
      return dispatchDashboardInput(
        pi,
        ctx,
        command.text,
        undefined,
        command.images,
      );
    case 'steer':
    case 'followUp':
      if (command.images?.length && !ctx.model?.input.includes('image'))
        throw new Error('The selected model does not support image input.');
      return {
        ...(await dispatchDashboardInput(
          pi,
          ctx,
          command.text,
          command.type === 'steer' ? 'steer' : 'followUp',
          command.images,
        )),
        mode: command.type,
      };
    case 'abort':
      ctx.abort();
      return { accepted: true };
    case 'shutdown':
      ctx.shutdown();
      return { accepted: true };
    case 'setModel': {
      const model = ctx.modelRegistry.find(command.provider, command.model);
      if (!model) throw new Error('Requested model is not available.');
      if (!(await pi.setModel(model)))
        throw new Error('Model authentication is unavailable.');
      return { accepted: true };
    }
    case 'setThinking':
      pi.setThinkingLevel(command.level as never);
      return { accepted: true };
    case 'setSessionName':
      pi.setSessionName(command.name);
      return { accepted: true };
    case 'interaction.answer':
      if (!broker.answer(command.interactionId, command.answer))
        throw new Error(
          'Interaction is already resolved or the answer is invalid.',
        );
      return { accepted: true };
    case 'interaction.cancel':
      if (!broker.cancel(command.interactionId))
        throw new Error('Interaction is already resolved.');
      return { accepted: true };
  }
}
