import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type ActionInvocation,
  isActionAvailable,
  parseActionInput,
  parseActionInvocation,
  type RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import type { BridgeCommand } from '@pi-dashboard/protocol/pi-runtime-protocol';
import type { InteractionBroker } from '../ask-user/broker';
import type { CapabilityActionHost } from '../shared/runtime/capability-action-host';
import {
  aggregateRuntimeCapabilities,
  getCapabilityRegistry,
} from '../shared/runtime/capability-registry';
import { getSessionScopeId } from '../shared/runtime/scoped-services';
import { dispatchDashboardInput } from './command-adapter';
import { cancelActiveCompaction } from './compaction-control';
import {
  isQueueDraftCommand,
  type QueueDraftStore,
  queueDraftError,
} from './queue-draft-store';

export type CommandHandler = (
  command: BridgeCommand,
  capabilities: RuntimeCapabilitySnapshot,
) => Promise<unknown>;

async function dispatchSemanticAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  broker: InteractionBroker,
  command: Extract<BridgeCommand, { type: 'action.invoke' }>,
  capabilities: RuntimeCapabilitySnapshot,
): Promise<unknown> {
  const invocation: ActionInvocation = parseActionInvocation(command);
  const registry = getCapabilityRegistry(getSessionScopeId(ctx));
  const action = registry.findAction(invocation.actionId);
  const handler = registry.findHandler(invocation.actionId);
  const advertisedAction = capabilities.manifests
    .flatMap((manifest) => manifest.actions)
    .find((candidate) => candidate.id === invocation.actionId);
  if (!advertisedAction)
    throw Object.assign(
      new Error(`Unknown dashboard action: ${invocation.actionId}`),
      { code: 'unknown-action' },
    );
  if (!action || !handler)
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
  const host: CapabilityActionHost = {
    scopeId: getSessionScopeId(ctx),
    broker,
    ctx,
    pi,
  };
  return handler(invocation, host);
}

export async function dispatchDashboardCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  broker: InteractionBroker,
  command: BridgeCommand,
  capabilities = aggregateRuntimeCapabilities(getSessionScopeId(ctx)),
  queueDrafts?: QueueDraftStore,
): Promise<unknown> {
  if (command.type === 'action.invoke')
    return dispatchSemanticAction(pi, ctx, broker, command, capabilities);
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
    case 'compact.cancel':
      cancelActiveCompaction();
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
