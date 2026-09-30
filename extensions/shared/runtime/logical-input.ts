import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { resolveHostAgentSession } from './keyed-turn-scheduler';
import { getScopedServices } from './scoped-services';

export const REQUEST_STEERING_ENTRY_TYPE = 'steering-message';
const stateKey = Symbol.for('pi.logical-request-input.state');
type InputState = {
  steeringMessages: WeakSet<object>;
  sessions: Map<string, AgentSession>;
  installedQueues: WeakSet<object>;
  installedAgents: WeakSet<object>;
};
const globalState = globalThis as typeof globalThis & {
  [stateKey]?: InputState;
};
const state = globalState[stateKey] ?? {
  steeringMessages: new WeakSet<object>(),
  sessions: new Map<string, AgentSession>(),
  installedQueues: new WeakSet<object>(),
  installedAgents: new WeakSet<object>(),
};
globalState[stateKey] = state;
const { steeringMessages, sessions, installedQueues, installedAgents } = state;
const shimKey = Symbol.for('pi.logical-request-input');

type NativeMessage = Parameters<AgentSession['agent']['steer']>[0];
type Queue = {
  messages: NativeMessage[];
  mode: string;
  peek(): NativeMessage[];
  drain(): NativeMessage[];
  hasItems(): boolean;
};
type Session = {
  _runAgentPrompt(messages: NativeMessage | NativeMessage[]): Promise<void>;
};

export function isLogicalSteering(message: object): boolean {
  return steeringMessages.has(message);
}

export function markLogicalSteering(message: object): void {
  steeringMessages.add(message);
}

function requestOpen(session: AgentSession): boolean {
  return (
    getScopedServices(
      session.sessionManager.getSessionId(),
    ).requestDependencies?.isOpenNow?.() ??
    getScopedServices(
      session.sessionManager.getSessionId(),
    ).requestDependencies?.isOpen?.() ??
    getScopedServices(
      session.sessionManager.getSessionId(),
    ).requestDependencies?.hasPending() ??
    false
  );
}

function holdUserFollowUps(session: AgentSession): void {
  const queue = (session.agent as unknown as { followUpQueue: Queue })
    .followUpQueue;
  if (!queue || installedQueues.has(queue)) return;
  installedQueues.add(queue);
  const peek = queue.peek.bind(queue);
  const drain = queue.drain.bind(queue);
  const hasItems = queue.hasItems.bind(queue);
  queue.peek = () => {
    if (!requestOpen(session)) return peek();
    const eligible = queue.messages.filter(
      (message) => message.role !== 'user',
    );
    return queue.mode === 'all' ? eligible : eligible.slice(0, 1);
  };
  queue.drain = () => {
    if (!requestOpen(session)) return drain();
    const selected = queue.peek();
    const selectedSet = new Set(selected);
    queue.messages = queue.messages.filter(
      (message) => !selectedSet.has(message),
    );
    return selected;
  };
  queue.hasItems = () =>
    requestOpen(session) ? queue.peek().length > 0 : hasItems();
}

/** A narrow SDK shim. User follow-ups stay in the native queue until logical closure. */
export function installLogicalInputShim(): boolean {
  const host = resolveHostAgentSession();
  if (!host) return false;
  const prototype = host.prototype as AgentSession & { [shimKey]?: boolean };
  if (prototype[shimKey]) return true;
  if (typeof (prototype as unknown as Session)._runAgentPrompt !== 'function')
    return false;
  const originalPrompt = (prototype as unknown as Session)._runAgentPrompt;
  (prototype as unknown as Session)._runAgentPrompt = async function (
    messages,
  ) {
    const session = this as unknown as AgentSession;
    const sessionId = session.sessionManager.getSessionId();
    sessions.set(sessionId, session);
    holdUserFollowUps(session);
    if (!installedAgents.has(session.agent)) {
      installedAgents.add(session.agent);
      const steer = session.agent.steer.bind(session.agent);
      session.agent.steer = (message) => {
        if (message.role === 'user') markLogicalSteering(message);
        steer(message);
      };
    }
    return originalPrompt.call(this, messages);
  };
  const original = prototype.sendUserMessage;
  prototype.sendUserMessage = async function (content, options) {
    if (
      options?.deliverAs === 'followUp' &&
      (this.isStreaming || requestOpen(this))
    ) {
      const text =
        typeof content === 'string'
          ? content
          : content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n');
      const images =
        typeof content === 'string'
          ? undefined
          : content.filter((part) => part.type === 'image');
      await this.followUp(text, images, { source: 'extension' });
      return;
    }
    if (
      options?.deliverAs === 'steer' &&
      !this.isStreaming &&
      requestOpen(this)
    ) {
      const message: NativeMessage = {
        role: 'user',
        content:
          typeof content === 'string'
            ? [{ type: 'text', text: content }]
            : content,
        timestamp: Date.now(),
      };
      markLogicalSteering(message);
      // _runAgentPrompt is the same SDK entry used by idle custom-result delivery.
      void (this as unknown as Session)
        ._runAgentPrompt(message)
        .catch((error) =>
          console.error('logical request steering failed', error),
        );
      return;
    }
    await original.call(this, content, options);
  };
  Object.defineProperty(prototype, shimKey, { value: true });
  return true;
}

export function releaseLogicalFollowUps(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session || requestOpen(session)) return;
  // Run only accepted queued input, never an unconditional wake or polling loop.
  setTimeout(() => {
    if (
      sessions.get(sessionId) !== session ||
      session.sessionManager.getSessionId() !== sessionId ||
      session.isStreaming ||
      requestOpen(session)
    )
      return;
    const queue = (session.agent as unknown as { followUpQueue: Queue })
      .followUpQueue;
    const messages = queue?.drain() ?? [];
    if (!messages.length) return;
    void (session as unknown as Session)
      ._runAgentPrompt(messages)
      .catch((error) =>
        console.error('logical request follow-up failed', error),
      );
  }, 0);
}

export function forgetLogicalInput(sessionId: string): void {
  const session = sessions.get(sessionId);
  session?.clearQueue();
  sessions.delete(sessionId);
}
