import type {
  BridgeEvent,
  DashboardEventEnvelope,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';

export interface RuntimeReducerState {
  snapshot: RuntimeSnapshot;
  runtimeEpoch?: string;
  lastCursor: number;
  lastRuntimeSeq: number;
  /** Epochs which have been replaced; late frames from them are inert. */
  retiredEpochs: readonly string[];
}

export interface RuntimeReducerEvent {
  event: BridgeEvent;
  cursor?: number;
  emittedAt?: number;
  runtimeId?: string;
  runtimeEpoch?: string;
  runtimeSeq?: number;
  sessionId?: string;
}

export interface RuntimeReduceResult {
  state: RuntimeReducerState;
  accepted: boolean;
  reason?: 'old-cursor' | 'duplicate-runtime-seq' | 'old-runtime-epoch';
}

function asReducerEvent(
  input: DashboardEventEnvelope | RuntimeReducerEvent | BridgeEvent,
): RuntimeReducerEvent {
  if (
    typeof input === 'object' &&
    input !== null &&
    'event' in input &&
    typeof (input as { event?: unknown }).event === 'object'
  )
    return input as RuntimeReducerEvent;
  return { event: input as BridgeEvent };
}

export function createRuntimeReducerState(
  snapshot: RuntimeSnapshot,
  options: {
    runtimeEpoch?: string;
    runtimeSeq?: number;
    cursor?: number;
  } = {},
): RuntimeReducerState {
  return {
    snapshot,
    runtimeEpoch: options.runtimeEpoch,
    lastCursor: options.cursor ?? -1,
    lastRuntimeSeq: options.runtimeSeq ?? -1,
    retiredEpochs: [],
  };
}

/** Compatibility spelling for callers that call the state a projection. */
export const createRuntimeProjection = createRuntimeReducerState;

function mergeRuntimeEvent(
  snapshot: RuntimeSnapshot,
  event: BridgeEvent,
): RuntimeSnapshot {
  switch (event.type) {
    case 'runtime.hello':
      // Hello is authoritative only when the caller explicitly installs a new
      // runtime epoch. A hello in an established epoch cannot replace identity.
      return snapshot;
    case 'runtime.heartbeat':
    case 'runtime.stateChanged': {
      const update = event.snapshot;
      return {
        ...snapshot,
        ...(update?.cwd === undefined ? {} : { cwd: update.cwd }),
        ...(update?.workspaceHint === undefined
          ? {}
          : { workspaceHint: update.workspaceHint }),
        ...(update?.tmux === undefined ? {} : { tmux: update.tmux }),
        liveState: event.state,
        ...(update?.session === undefined ? {} : { session: update.session }),
        ...(update?.model === undefined ? {} : { model: update.model }),
        ...(update?.contextUsage === undefined
          ? {}
          : { contextUsage: update.contextUsage }),
        ...(update?.pendingInteractions === undefined
          ? {}
          : { pendingInteractions: update.pendingInteractions }),
        ...(update?.lastError === undefined
          ? {}
          : { lastError: update.lastError }),
        ...(update?.online === undefined ? {} : { online: update.online }),
        ...(update?.lastSeenAt === undefined
          ? {}
          : { lastSeenAt: update.lastSeenAt }),
        ...(update?.capabilities === undefined
          ? {}
          : { capabilities: update.capabilities }),
      };
    }
    case 'session.changed':
    case 'session.snapshot':
      return { ...snapshot, session: event.session };
    case 'interaction.requested':
      return {
        ...snapshot,
        pendingInteractions: [
          ...snapshot.pendingInteractions.filter(
            (item) => item.id !== event.interaction.id,
          ),
          event.interaction,
        ],
        liveState: 'waiting',
      };
    case 'interaction.resolved':
      return {
        ...snapshot,
        pendingInteractions: snapshot.pendingInteractions.filter(
          (item) => item.id !== event.interactionId,
        ),
      };
    case 'agent.settled':
      return {
        ...snapshot,
        liveState: snapshot.pendingInteractions.length > 0 ? 'waiting' : 'idle',
      };
    case 'runtime.goodbye':
      return { ...snapshot, online: false };
    default:
      // Transcript events intentionally do not mutate runtime state.
      return snapshot;
  }
}

/**
 * Apply one bridge event. Cursor and runtime sequence checks happen before any
 * merge, making replay and duplicate delivery safe. A new epoch is accepted
 * as a replacement and retires the previous one; a retired epoch can never
 * write into the replacement projection.
 */
export function applyRuntimeEvent(
  current: RuntimeReducerState,
  input: DashboardEventEnvelope | RuntimeReducerEvent | BridgeEvent,
): RuntimeReduceResult {
  const incoming = asReducerEvent(input);
  if (incoming.cursor !== undefined && incoming.cursor <= current.lastCursor)
    return { state: current, accepted: false, reason: 'old-cursor' };

  const epoch = incoming.runtimeEpoch;
  let nextEpoch = current.runtimeEpoch;
  let retired = current.retiredEpochs;
  let replacingEpoch = false;
  if (
    epoch !== undefined &&
    current.runtimeEpoch !== undefined &&
    epoch !== current.runtimeEpoch
  ) {
    if (current.retiredEpochs.includes(epoch))
      return { state: current, accepted: false, reason: 'old-runtime-epoch' };
    replacingEpoch = true;
    retired = [...current.retiredEpochs, current.runtimeEpoch];
    nextEpoch = epoch;
  } else if (epoch !== undefined && current.runtimeEpoch === undefined) {
    nextEpoch = epoch;
  }

  if (
    !replacingEpoch &&
    epoch !== undefined &&
    current.retiredEpochs.includes(epoch)
  )
    return { state: current, accepted: false, reason: 'old-runtime-epoch' };
  if (
    !replacingEpoch &&
    incoming.runtimeSeq !== undefined &&
    incoming.runtimeSeq <= current.lastRuntimeSeq
  )
    return { state: current, accepted: false, reason: 'duplicate-runtime-seq' };

  let snapshot = current.snapshot;
  if (
    incoming.event.type === 'runtime.hello' &&
    (replacingEpoch || current.runtimeEpoch === undefined)
  )
    snapshot = incoming.event.snapshot;
  snapshot = mergeRuntimeEvent(snapshot, incoming.event);
  const state: RuntimeReducerState = {
    snapshot,
    runtimeEpoch: nextEpoch,
    lastCursor: incoming.cursor ?? current.lastCursor,
    lastRuntimeSeq: replacingEpoch
      ? (incoming.runtimeSeq ?? -1)
      : (incoming.runtimeSeq ?? current.lastRuntimeSeq),
    retiredEpochs: retired,
  };
  return { state, accepted: true };
}

/** Pure reducer form suitable for replay and reducer libraries. */
export function reduceRuntime(
  current: RuntimeReducerState,
  input: DashboardEventEnvelope | RuntimeReducerEvent | BridgeEvent,
): RuntimeReducerState {
  return applyRuntimeEvent(current, input).state;
}
export const runtimeReducer = reduceRuntime;
export const reduceRuntimeEvent = reduceRuntime;

/** Install an authoritative replacement snapshot for a new runtime epoch. */
export function replaceRuntimeEpoch(
  current: RuntimeReducerState,
  snapshot: RuntimeSnapshot,
  runtimeEpoch: string,
  runtimeSeq = -1,
  cursor = current.lastCursor,
): RuntimeReducerState {
  const retired = current.runtimeEpoch
    ? [...current.retiredEpochs, current.runtimeEpoch]
    : current.retiredEpochs;
  return {
    snapshot,
    runtimeEpoch,
    lastCursor: cursor,
    lastRuntimeSeq: runtimeSeq,
    retiredEpochs: retired,
  };
}
