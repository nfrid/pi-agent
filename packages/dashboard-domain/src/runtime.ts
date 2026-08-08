import {
  type BridgeEvent,
  type DashboardEventEnvelope,
  parseRuntimeCapabilitySnapshot,
  type RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import {
  applyTransportOrdering,
  type TransportRejectReason,
  type TransportState,
} from './transport.js';

export interface RuntimeReducerState extends TransportState {
  snapshot: RuntimeSnapshot;
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
  reason?: TransportRejectReason | 'invalid-capabilities';
}

function validateEventCapabilities(event: BridgeEvent): void {
  if (event.type === 'runtime.hello') {
    if (event.snapshot.capabilities)
      parseRuntimeCapabilitySnapshot(event.snapshot.capabilities);
    const capabilities = event.capabilities;
    if (capabilities?.extensions)
      parseRuntimeCapabilitySnapshot(capabilities.extensions);
    if (capabilities?.extensionCapabilities)
      parseRuntimeCapabilitySnapshot(capabilities.extensionCapabilities);
    if (
      capabilities?.capabilitySummaries !== undefined ||
      capabilities?.manifests !== undefined
    )
      parseRuntimeCapabilitySnapshot({
        version: 1,
        capabilities: capabilities.capabilitySummaries ?? [],
        manifests: capabilities.manifests ?? [],
      });
  } else if (
    (event.type === 'runtime.heartbeat' ||
      event.type === 'runtime.stateChanged') &&
    event.snapshot?.capabilities
  )
    parseRuntimeCapabilitySnapshot(event.snapshot.capabilities);
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
        ...(update?.modelCatalog === undefined
          ? {}
          : { modelCatalog: update.modelCatalog }),
        ...(update?.thinkingLevels === undefined
          ? {}
          : { thinkingLevels: update.thinkingLevels }),
        ...(update?.contextUsage === undefined
          ? {}
          : { contextUsage: update.contextUsage }),
        ...(update?.pendingInteractions === undefined
          ? {}
          : { pendingInteractions: update.pendingInteractions }),
        ...(update?.queueDrafts === undefined
          ? {}
          : { queueDrafts: update.queueDrafts }),
        ...(update?.extensionSurfaces === undefined
          ? {}
          : { extensionSurfaces: update.extensionSurfaces }),
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
  try {
    validateEventCapabilities(incoming.event);
  } catch {
    // Capability patches are optional metadata. Invalid semantic updates must
    // not alter the runtime projection or make reducers throw.
    return { state: current, accepted: false, reason: 'invalid-capabilities' };
  }
  const transport = applyTransportOrdering(current, incoming);
  if (!transport.accepted)
    return { state: current, accepted: false, reason: transport.reason };

  let snapshot = current.snapshot;
  if (
    incoming.event.type === 'runtime.hello' &&
    (transport.replacingEpoch || current.runtimeEpoch === undefined)
  )
    snapshot = incoming.event.snapshot;
  snapshot = mergeRuntimeEvent(snapshot, incoming.event);
  const state: RuntimeReducerState = { snapshot, ...transport.state };
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
