import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from '@earendil-works/pi-coding-agent';
import {
  EXTERNAL_DELIVERY_RECEIPT,
  type ExternalDeliveryReceipt,
  externalDeliveryReceipt,
} from '@pi-dashboard/protocol';
import { hasPendingRequestDependencies } from '../shared/runtime/agent-lifecycle';
import { resolveHostAgentSession } from '../shared/runtime/keyed-turn-scheduler';
import {
  installLogicalInputShim,
  markLogicalSteering,
} from '../shared/runtime/logical-input';

type SteeringScope = {
  deliveryId: string;
  sessionId: string;
  leafId: string;
  queued: boolean;
};
type SteeringIdentity = { deliveryId: string; sessionId: string };
const steeringScope = new AsyncLocalStorage<SteeringScope>();
const steeringIdentities = new WeakMap<object, SteeringIdentity>();
const pendingSteeringMessages = new Map<
  string,
  Array<{ message: object; identity: SteeringIdentity }>
>();
const steeringShimKey = Symbol.for('pi.remote-control.external-steering');

/** Only public methods, and only inside an authenticated external dispatch. */
export function installExternalSteeringShim(): boolean {
  installLogicalInputShim();
  const host = resolveHostAgentSession();
  if (!host) return false;
  const prototype = host.prototype as AgentSession & {
    [steeringShimKey]?: {
      original: AgentSession['sendUserMessage'];
      handle: AgentSession['sendUserMessage'];
    };
  };
  const existing = prototype[steeringShimKey];
  const original = existing?.original ?? prototype.sendUserMessage;
  if (typeof original !== 'function') return false;
  const handle: AgentSession['sendUserMessage'] = function (
    this: AgentSession,
    content,
    options,
  ) {
    const scope = steeringScope.getStore();
    if (!scope) return original.call(this, content, options);
    if (scope.queued || options?.deliverAs !== 'steer')
      throw new Error('Invalid external steering dispatch.');
    if (
      this.sessionManager.getSessionId() !== scope.sessionId ||
      !this.sessionManager
        .getBranch()
        .some((entry) => entry.id === scope.leafId)
    )
      throw Object.assign(
        new Error('The native source session or branch was replaced.'),
        { code: 'orchestration-conflict' },
      );
    if (!this.isStreaming && !hasPendingRequestDependencies(scope.sessionId))
      throw Object.assign(
        new Error('Runtime is no longer working; use idle prompt delivery.'),
        { code: 'busy' },
      );
    const nativeMessage: MessageEndEvent['message'] = {
      role: 'user',
      content:
        typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : content,
      timestamp: Date.now(),
    } as MessageEndEvent['message'];
    const identity = {
      deliveryId: scope.deliveryId,
      sessionId: scope.sessionId,
    };
    steeringIdentities.set(nativeMessage, identity);
    markLogicalSteering(nativeMessage);
    try {
      if (this.isStreaming) this.agent.steer(nativeMessage);
      else {
        const session = this as unknown as {
          _runAgentPrompt(message: MessageEndEvent['message']): Promise<void>;
        };
        void session
          ._runAgentPrompt(nativeMessage)
          .catch((error) =>
            console.error('external idle steering failed', error),
          );
      }
      scope.queued = true;
    } catch (error) {
      steeringIdentities.delete(nativeMessage);
      throw error;
    }
    return Promise.resolve();
  };
  if (existing) {
    existing.handle = handle;
    return true;
  }
  const state = { original, handle };
  prototype.sendUserMessage = function (content, options) {
    return state.handle.call(this, content, options);
  };
  Object.defineProperty(prototype, steeringShimKey, { value: state });
  return true;
}

type Dispatch = {
  deliveryId: string;
  sessionId: string;
  sawUser: boolean;
  message?: MessageEndEvent['message'];
  recorded: boolean;
};
const dispatchScope = new AsyncLocalStorage<Dispatch>();

/** Async provenance, not the next message's text/order, identifies this input. */
export function withExternalDelivery<T>(
  ctx: ExtensionContext,
  deliveryId: string,
  send: () => T,
  expectedSessionId?: string,
  expectedLeafId?: string,
): T {
  if (
    expectedSessionId !== undefined &&
    ctx.sessionManager.getSessionId() !== expectedSessionId
  )
    throw new Error(
      'The source session has been replaced; the old answer was not delivered.',
    );
  if (
    expectedLeafId !== undefined &&
    !ctx.sessionManager.getBranch().some((entry) => entry.id === expectedLeafId)
  )
    throw Object.assign(
      new Error('The source branch anchor is no longer selected.'),
      { code: 'orchestration-conflict' },
    );
  if (
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    hasPendingRequestDependencies(ctx.sessionManager.getSessionId())
  )
    throw Object.assign(
      new Error(
        'External input requires an idle runtime with no queued messages or open logical request.',
      ),
      { code: 'busy' },
    );
  if (
    ctx.sessionManager
      .getEntries()
      .some(
        (entry) => externalDeliveryReceipt(entry)?.deliveryId === deliveryId,
      )
  )
    throw new Error('This external delivery already has a persisted receipt.');
  return dispatchScope.run(
    {
      deliveryId,
      sessionId: ctx.sessionManager.getSessionId(),
      sawUser: false,
      recorded: false,
    },
    send,
  );
}

/** Admission only. The public SDK steering queue owns subsequent processing. */
export async function withExternalSteering<T>(
  ctx: ExtensionContext,
  deliveryId: string,
  expectedSessionId: string | undefined,
  expectedLeafId: string | undefined,
  send: () => Promise<T>,
): Promise<T> {
  if (
    !expectedSessionId ||
    ctx.sessionManager.getSessionId() !== expectedSessionId
  )
    throw Object.assign(new Error('The source session has been replaced.'), {
      code: 'orchestration-conflict',
    });
  if (
    !expectedLeafId ||
    !ctx.sessionManager.getBranch().some((entry) => entry.id === expectedLeafId)
  )
    throw Object.assign(
      new Error('The source branch anchor is no longer selected.'),
      { code: 'orchestration-conflict' },
    );
  if (!installExternalSteeringShim())
    throw Object.assign(new Error('Native steering shim is unavailable.'), {
      code: 'busy',
    });
  const scope: SteeringScope = {
    deliveryId,
    sessionId: expectedSessionId,
    leafId: expectedLeafId,
    queued: false,
  };
  const result = await steeringScope.run(scope, send);
  if (!scope.queued)
    throw new Error('Native steering queue acceptance is unknown.');
  return result;
}

export function installExternalDeliveryReceipts(pi: ExtensionAPI): void {
  pi.on('message_end', (event, ctx) => {
    const identity = steeringIdentities.get(event.message);
    if (
      identity &&
      event.message.role === 'user' &&
      ctx.sessionManager.getSessionId() === identity.sessionId
    ) {
      const pending = pendingSteeringMessages.get(identity.sessionId) ?? [];
      pending.push({ message: event.message, identity });
      pendingSteeringMessages.set(identity.sessionId, pending);
    }
    const dispatch = dispatchScope.getStore();
    if (!dispatch || dispatch.sawUser || event.message.role !== 'user') return;
    dispatch.sawUser = true;
    if (ctx.sessionManager.getSessionId() === dispatch.sessionId)
      dispatch.message = event.message;
  });
  pi.on('context', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const pending = pendingSteeringMessages.get(sessionId) ?? [];
    if (pending.length) {
      const branch = ctx.sessionManager.getBranch();
      const unresolved = pending.filter(({ message, identity }) => {
        const entries = branch.filter(
          (entry) => entry.type === 'message' && entry.message === message,
        );
        if (entries.length !== 1 || !entries[0]) return true;
        pi.appendEntry<ExternalDeliveryReceipt>(EXTERNAL_DELIVERY_RECEIPT, {
          version: 1,
          deliveryId: identity.deliveryId,
          userEntryId: entries[0].id,
        });
        return false;
      });
      if (unresolved.length) pendingSteeringMessages.set(sessionId, unresolved);
      else pendingSteeringMessages.delete(sessionId);
    }
    const dispatch = dispatchScope.getStore();
    if (
      !dispatch ||
      dispatch.recorded ||
      !dispatch.message ||
      ctx.sessionManager.getSessionId() !== dispatch.sessionId
    )
      return;
    // The SDK persists message_end after extension handlers. At context time
    // that exact native object has an entry ID. Never substitute text/timestamps
    // if this invariant changes: a missing receipt must fail closed at the API.
    const entries = ctx.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === 'message' && entry.message === dispatch.message,
      );
    if (entries.length !== 1 || !entries[0]) return;
    pi.appendEntry<ExternalDeliveryReceipt>(EXTERNAL_DELIVERY_RECEIPT, {
      version: 1,
      deliveryId: dispatch.deliveryId,
      userEntryId: entries[0].id,
    });
    dispatch.recorded = true;
  });
}
