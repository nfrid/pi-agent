import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  AgentSession,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

export type TurnDeliveryTiming = 'steer' | 'followUp';
export type TurnDeliveryMessage = Parameters<ExtensionAPI['sendMessage']>[0];

const CONTROL_MESSAGE_TYPE = 'pi-keyed-turn-control';
const DELIVERY_MARKER = '__piKeyedTurnDelivery';
const shimStateKey = Symbol.for('pi.keyed-turn-scheduler.shim');
const runtimeStateKey = Symbol.for('pi.keyed-turn-scheduler.runtime');

type AppMessage = TurnDeliveryMessage & {
  role: 'custom';
  timestamp: number;
};

type PendingQueue = { messages: AppMessage[] };

type SessionLike = {
  readonly isStreaming: boolean;
  readonly agent: {
    steer(message: AppMessage): void;
    followUp(message: AppMessage): void;
    steeringQueue?: PendingQueue;
    followUpQueue?: PendingQueue;
  };
  _runAgentPrompt(message: AppMessage): Promise<void>;
};

type DeliveryRecord = {
  readonly key: string;
  readonly token: number;
  readonly timing: TurnDeliveryTiming;
  readonly session: SessionLike;
  readonly message: AppMessage;
};

type RuntimeState = {
  readonly deliveries: Map<string, DeliveryRecord>;
  nextToken: number;
};

type AgentSessionConstructor = {
  readonly prototype: AgentSession;
};

type ShimState = {
  readonly original: AgentSession['sendCustomMessage'];
  handle: AgentSession['sendCustomMessage'];
};

type ControlRequest = {
  readonly operation: 'schedule';
  readonly key: string;
  readonly timing: TurnDeliveryTiming;
  readonly message: TurnDeliveryMessage;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  [runtimeStateKey]?: RuntimeState;
};
const requireModule = createRequire(__filename);

/** Resolve the constructor owned by the running CLI, not a second SDK copy. */
export function resolveHostAgentSession(): AgentSessionConstructor | undefined {
  const candidates: string[] = [];
  const entry = process.argv[1];
  if (entry) {
    const cliCandidate = path.join(path.dirname(entry), 'index.js');
    if (existsSync(cliCandidate)) candidates.push(cliCandidate);
  }
  for (const modulesPath of requireModule.resolve.paths(
    '@earendil-works/pi-coding-agent',
  ) ?? []) {
    const sdkCandidate = path.join(
      modulesPath,
      '@earendil-works/pi-coding-agent/dist/index.js',
    );
    if (existsSync(sdkCandidate)) candidates.push(sdkCandidate);
  }
  for (const candidate of new Set(candidates)) {
    try {
      const loaded = requireModule(candidate) as { AgentSession?: unknown };
      if (
        typeof loaded.AgentSession === 'function' &&
        typeof (loaded.AgentSession as AgentSessionConstructor).prototype
          .sendCustomMessage === 'function'
      )
        return loaded.AgentSession as AgentSessionConstructor;
    } catch {
      // Try the next candidate; scheduling falls back to ordinary sendMessage.
    }
  }
  return undefined;
}

function runtimeState(): RuntimeState {
  const existing = runtimeGlobal[runtimeStateKey];
  if (existing) {
    if (!Number.isSafeInteger(existing.nextToken) || existing.nextToken < 0)
      existing.nextToken = 0;
    return existing;
  }
  const created = {
    deliveries: new Map<string, DeliveryRecord>(),
    nextToken: 0,
  };
  runtimeGlobal[runtimeStateKey] = created;
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseControl(value: unknown): ControlRequest | undefined {
  if (!isRecord(value) || value.operation !== 'schedule') return undefined;
  if (
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    (value.timing !== 'steer' && value.timing !== 'followUp') ||
    !isRecord(value.message) ||
    typeof value.message.customType !== 'string'
  )
    return undefined;
  return value as unknown as ControlRequest;
}

function markedDetails(
  details: unknown,
  key: string,
  token: number,
): Record<string, unknown> {
  return {
    ...(isRecord(details) ? details : { originalDetails: details }),
    [DELIVERY_MARKER]: { key, token },
  };
}

function appMessage(
  message: TurnDeliveryMessage,
  key: string,
  token: number,
): AppMessage {
  return {
    role: 'custom',
    customType: message.customType,
    content: message.content ?? [],
    display: message.display,
    details: markedDetails(message.details, key, token),
    timestamp: Date.now(),
  };
}

function queueFor(
  session: SessionLike,
  timing: TurnDeliveryTiming,
): PendingQueue | undefined {
  return timing === 'steer'
    ? session.agent.steeringQueue
    : session.agent.followUpQueue;
}

function removeQueued(record: DeliveryRecord): boolean {
  const queue = queueFor(record.session, record.timing);
  if (!queue || !Array.isArray(queue.messages)) return false;
  const index = queue.messages.indexOf(record.message);
  if (index < 0) return false;
  queue.messages.splice(index, 1);
  return true;
}

/** Cancel one delivery while it is still waiting in Pi's agent queue. */
export function cancelKeyedTurn(key: string): boolean {
  const state = runtimeState();
  const record = state.deliveries.get(key);
  if (!record) return false;
  const removed = removeQueued(record);
  if (removed) state.deliveries.delete(key);
  return removed;
}

/** Cancel all still-queued deliveries owned by one session-scoped prefix. */
export function cancelKeyedTurns(prefix: string): number {
  const state = runtimeState();
  const keys = [...state.deliveries.keys()].filter((key) =>
    key.startsWith(prefix),
  );
  let cancelled = 0;
  for (const key of keys) {
    const record = state.deliveries.get(key);
    if (record && removeQueued(record)) cancelled++;
    state.deliveries.delete(key);
  }
  return cancelled;
}

/** Forget deliveries once their actual custom messages enter provider context. */
export function markKeyedTurnsEntered(messages: readonly unknown[]): void {
  const state = runtimeState();
  for (const value of messages) {
    if (!isRecord(value) || !isRecord(value.details)) continue;
    const marker = value.details[DELIVERY_MARKER];
    if (
      !isRecord(marker) ||
      typeof marker.key !== 'string' ||
      typeof marker.token !== 'number'
    )
      continue;
    const current = state.deliveries.get(marker.key);
    if (current?.token === marker.token) state.deliveries.delete(marker.key);
  }
}

/**
 * Install a narrow AgentSession shim that adds keyed replacement and
 * cancellation while retaining Pi's native steer/follow-up turn boundaries.
 */
export function installKeyedTurnSchedulerShim(): boolean {
  const hostClass = resolveHostAgentSession();
  if (!hostClass) return false;
  const prototype = hostClass.prototype as AgentSession & {
    [shimStateKey]?: ShimState;
  };
  const existing = prototype[shimStateKey];
  const original = existing?.original ?? prototype.sendCustomMessage;
  if (typeof original !== 'function') return false;

  const handle: AgentSession['sendCustomMessage'] = async function (
    this: AgentSession,
    message,
    options,
  ): Promise<void> {
    if (message.customType !== CONTROL_MESSAGE_TYPE) {
      return original.call(this, message, options);
    }
    const request = parseControl(message.details);
    if (!request) return;
    const session = this as unknown as SessionLike;
    const agent = session.agent;
    if (
      !agent ||
      typeof agent.steer !== 'function' ||
      typeof agent.followUp !== 'function' ||
      typeof session._runAgentPrompt !== 'function'
    ) {
      await original.call(this, request.message, {
        triggerTurn: true,
        deliverAs: request.timing,
      });
      return;
    }

    cancelKeyedTurn(request.key);
    const state = runtimeState();
    const token = ++state.nextToken;
    const queued = appMessage(request.message, request.key, token);
    const record: DeliveryRecord = {
      key: request.key,
      token,
      timing: request.timing,
      session,
      message: queued,
    };
    state.deliveries.set(request.key, record);
    if (session.isStreaming) {
      if (request.timing === 'followUp') agent.followUp(queued);
      else agent.steer(queued);
      return;
    }
    try {
      await session._runAgentPrompt(queued);
    } finally {
      if (state.deliveries.get(request.key)?.token === token)
        state.deliveries.delete(request.key);
    }
  };
  if (existing) {
    existing.handle = handle;
    return true;
  }
  const state: ShimState = { original, handle };
  prototype.sendCustomMessage = async function keyedSendCustomMessage(
    message,
    options,
  ): Promise<void> {
    return state.handle.call(this, message, options);
  };
  Object.defineProperty(prototype, shimStateKey, {
    configurable: false,
    enumerable: false,
    value: state,
  });
  return true;
}

/** Schedule or replace a keyed custom-message delivery. */
export function scheduleKeyedTurn(
  pi: ExtensionAPI,
  request: {
    readonly key: string;
    readonly timing: TurnDeliveryTiming;
    readonly message: TurnDeliveryMessage;
  },
): void {
  if (!installKeyedTurnSchedulerShim()) {
    pi.sendMessage(request.message, {
      deliverAs: request.timing,
      triggerTurn: true,
    });
    return;
  }
  pi.sendMessage(
    {
      customType: CONTROL_MESSAGE_TYPE,
      content: [],
      display: false,
      details: { operation: 'schedule', ...request },
    },
    { triggerTurn: false },
  );
}

export const KEYED_TURN_CONTROL_MESSAGE_TYPE = CONTROL_MESSAGE_TYPE;
export const KEYED_TURN_DELIVERY_MARKER = DELIVERY_MARKER;
