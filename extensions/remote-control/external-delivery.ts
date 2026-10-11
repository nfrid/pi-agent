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

import { recordHarnessFailure } from '../shared/telemetry';

type SteeringScope = {
  deliveryId: string;
  sessionId: string;
  leafId: string;
  queued: boolean;
};
type SteeringIdentity = { deliveryId: string; sessionId: string };
const steeringScope = new AsyncLocalStorage<SteeringScope>();
export type QueueSendSettlement =
  | { status: 'accepted' }
  | { status: 'uncertain'; detail: string };
const queueSendScope = new AsyncLocalStorage<{
  settle(outcome: QueueSendSettlement): void;
  entered(): void;
}>();
const queueObservationKey = Symbol.for(
  'pi.remote-control.queue-entry-observations',
);
const observationGlobal = globalThis as unknown as Record<symbol, unknown>;
let queueEntryObservations = observationGlobal[queueObservationKey] as
  | WeakMap<object, () => void>
  | undefined;
if (!queueEntryObservations) {
  queueEntryObservations = new WeakMap();
  observationGlobal[queueObservationKey] = queueEntryObservations;
}
const sharedQueueEntryObservations = queueEntryObservations as WeakMap<
  object,
  () => void
>;
const queuedMessagesSeen = new WeakSet<object>();
const queueAgentShimKey = Symbol.for('pi.remote-control.queue-agent-observer');
const pendingQueueMessages = new Map<
  string,
  Array<{ message: object; entered(): void }>
>();
const steeringIdentities = new WeakMap<object, SteeringIdentity>();
const pendingSteeringMessages = new Map<
  string,
  Array<{ message: object; identity: SteeringIdentity }>
>();
const steeringShimKey = Symbol.for('pi.remote-control.external-steering');

/** Run one extension send with identity through the SDK method that hides its promise. */
export function withQueueSendObservation<T>(
  send: () => T,
  settle: (outcome: QueueSendSettlement) => void,
  entered: () => void,
): { result: T; observed: boolean } {
  const observed = installExternalSteeringShim();
  let didEnter = false;
  const notifyEntered = () => {
    if (didEnter) return;
    didEnter = true;
    entered();
  };
  return {
    result: queueSendScope.run({ settle, entered: notifyEntered }, send),
    observed,
  };
}

type QueueAgentObservationState = {
  originals: Map<string, (...args: unknown[]) => unknown>;
  wrappers?: Map<string, (...args: unknown[]) => unknown>;
  observe?: (args: unknown[]) => void;
};

export function installQueueAgentObservation(session: AgentSession): boolean {
  const agent = session.agent as unknown as Record<string | symbol, unknown>;
  const existing = agent[queueAgentShimKey] as
    | QueueAgentObservationState
    | undefined;
  const state: QueueAgentObservationState = existing ?? {
    originals: new Map(),
  };
  let wrappers = state.wrappers;
  if (!wrappers) {
    wrappers = new Map();
    state.wrappers = wrappers;
  }
  const names = ['steer', 'followUp', 'prompt'];
  if (
    names.some(
      (name) =>
        typeof agent[name] !== 'function' ||
        (wrappers.has(name) && agent[name] !== wrappers.get(name)),
    )
  )
    return false;
  state.observe = (args) => {
    const entered = queueSendScope.getStore()?.entered;
    if (!entered) return;
    const message = args[0];
    const messages = Array.isArray(message) ? message : [message];
    for (const item of messages)
      if (
        item &&
        typeof item === 'object' &&
        (item as { role?: unknown }).role === 'user'
      )
        sharedQueueEntryObservations.set(item, entered);
  };
  const changed: string[] = [];
  try {
    for (const name of names) {
      const current = agent[name] as (...args: unknown[]) => unknown;
      const wrapped = wrappers.get(name);
      if (wrapped && current === wrapped) continue;
      const original = state.originals.get(name) ?? current;
      state.originals.set(name, original);
      const next = function (this: unknown, ...args: unknown[]) {
        state.observe?.(args);
        return original.apply(this, args);
      };
      agent[name] = next;
      wrappers.set(name, next);
      changed.push(name);
    }
    if (!existing)
      Object.defineProperty(agent, queueAgentShimKey, { value: state });
    return true;
  } catch {
    for (const name of changed) {
      agent[name] = state.originals.get(name);
      wrappers.delete(name);
      state.originals.delete(name);
    }
    return false;
  }
}

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
    if (!scope) {
      const queueSend = queueSendScope.getStore();
      if (queueSend && !installQueueAgentObservation(this))
        throw new Error('Native queue identity observation is unavailable.');
      const result = original.call(this, content, options);
      if (queueSend)
        void Promise.resolve(result).then(
          () => queueSend.settle({ status: 'accepted' }),
          (error: unknown) =>
            queueSend.settle({
              status: 'uncertain',
              detail: error instanceof Error ? error.message : String(error),
            }),
        );
      return result;
    }
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
    const queueSend = queueSendScope.getStore();
    if (queueSend)
      sharedQueueEntryObservations.set(nativeMessage, queueSend.entered);
    markLogicalSteering(nativeMessage);
    try {
      if (this.isStreaming) this.agent.steer(nativeMessage);
      else {
        const session = this as unknown as {
          _runAgentPrompt(message: MessageEndEvent['message']): Promise<void>;
        };
        void session._runAgentPrompt(nativeMessage).catch((error) => {
          recordHarnessFailure(
            'remote-control',
            'external-steering-failed',
            error,
            scope.sessionId,
          );
          console.error('external idle steering failed', error);
        });
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

export function clearQueueSendObservations(sessionId: string): void {
  pendingQueueMessages.delete(sessionId);
  pendingSteeringMessages.delete(sessionId);
}

export function installExternalDeliveryReceipts(pi: ExtensionAPI): void {
  pi.on('message_end', (event, ctx) => {
    const entered = sharedQueueEntryObservations.get(event.message);
    if (
      entered &&
      event.message.role === 'user' &&
      !queuedMessagesSeen.has(event.message)
    ) {
      queuedMessagesSeen.add(event.message);
      sharedQueueEntryObservations.delete(event.message);
      const sessionId = ctx.sessionManager.getSessionId();
      const pending = pendingQueueMessages.get(sessionId) ?? [];
      pending.push({ message: event.message, entered });
      pendingQueueMessages.set(sessionId, pending.slice(-32));
    }
    const identity = steeringIdentities.get(event.message);
    if (
      identity &&
      event.message.role === 'user' &&
      ctx.sessionManager.getSessionId() === identity.sessionId
    ) {
      const pending = pendingSteeringMessages.get(identity.sessionId) ?? [];
      pending.push({ message: event.message, identity });
      pendingSteeringMessages.set(identity.sessionId, pending.slice(-32));
    }
    const dispatch = dispatchScope.getStore();
    if (!dispatch || dispatch.sawUser || event.message.role !== 'user') return;
    dispatch.sawUser = true;
    if (ctx.sessionManager.getSessionId() === dispatch.sessionId)
      dispatch.message = event.message;
  });
  pi.on('context', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const queued = pendingQueueMessages.get(sessionId) ?? [];
    if (queued.length) {
      const branch = ctx.sessionManager.getBranch();
      const unresolved = queued.filter(({ message, entered }) => {
        const entries = branch.filter(
          (entry) => entry.type === 'message' && entry.message === message,
        );
        if (entries.length !== 1) return true;
        entered();
        return false;
      });
      if (unresolved.length) pendingQueueMessages.set(sessionId, unresolved);
      else pendingQueueMessages.delete(sessionId);
    }
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
