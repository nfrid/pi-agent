import type {
  BridgeEvent,
  DashboardEventEnvelope,
  NormalizedMessagePayload,
  NormalizedToolPayload,
} from '@pi-dashboard/protocol';
import { applyTransportOrdering } from './transport.js';
import {
  tryParseNormalizedMessagePayload,
  tryParseNormalizedToolPayload,
} from './validation.js';

export type TranscriptEntityStatus =
  | 'streaming'
  | 'pending'
  | 'running'
  | 'finished'
  | 'error';

/** Delivery modes represented by durable user-message markers. */
export type TranscriptDeliveryMode = 'steer' | 'followUp';

export const STEERING_MESSAGE_MARKER_TYPE = 'steering-message';

export interface TranscriptMessageItem {
  kind: 'message';
  messageId: string;
  role: string;
  content: unknown;
  timestamp?: number | string;
  turnId?: string;
  toolCallIds?: readonly string[];
  deliveryMode?: TranscriptDeliveryMode;
  status: 'streaming' | 'finished';
  data?: unknown;
}

export interface TranscriptToolItem {
  kind: 'tool';
  toolCallId: string;
  name: string;
  arguments?: unknown;
  result?: unknown;
  isError?: boolean;
  status: TranscriptEntityStatus;
  turnId?: string;
  data?: unknown;
}

export interface TranscriptOtherItem {
  kind: 'other';
  id: string;
  raw: unknown;
}

export type TranscriptItem =
  | TranscriptMessageItem
  | TranscriptToolItem
  | TranscriptOtherItem;

export interface TranscriptProjection {
  sessionId?: string;
  order: readonly string[];
  items: Readonly<Record<string, TranscriptItem>>;
  lastCursor: number;
  runtimeEpoch?: string;
  lastRuntimeSeq: number;
  retiredEpochs: readonly string[];
}

/** Tool outcome names consumed by the shared activity model. */
export type TranscriptActivityToolStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error';

/**
 * Canonical transcript-to-render projection.  The web renderer should consume
 * this shape rather than rediscovering identities, tool pairing, or lifecycle
 * state from compatibility entries.
 */
export interface TranscriptRenderMessageItem {
  kind: 'message';
  key: string;
  messageId: string;
  role: string;
  content: unknown;
  timestamp?: number | string;
  turnId?: string;
  toolCallIds: readonly string[];
  associatedToolCallIds: readonly string[];
  deliveryMode?: TranscriptDeliveryMode;
  status: TranscriptMessageItem['status'];
  streaming: boolean;
  preparing: boolean;
}

export interface TranscriptRenderToolItem {
  kind: 'tool';
  key: string;
  toolCallId: string;
  name: string;
  arguments?: unknown;
  result?: unknown;
  isError?: boolean;
  status: TranscriptActivityToolStatus;
  turnId?: string;
  data?: unknown;
}

export interface TranscriptRenderOtherItem {
  kind: 'other';
  key: string;
  id: string;
  raw: unknown;
}

export type TranscriptRenderItem =
  | TranscriptRenderMessageItem
  | TranscriptRenderToolItem
  | TranscriptRenderOtherItem;

export interface TranscriptRenderProjection {
  sessionId?: string;
  items: readonly TranscriptRenderItem[];
}

export type TranscriptReducerState = TranscriptProjection;

export interface TranscriptReducerEvent {
  event: BridgeEvent;
  cursor?: number;
  emittedAt?: number;
  runtimeId?: string;
  runtimeEpoch?: string;
  runtimeSeq?: number;
  sessionId?: string;
}

export interface TranscriptReduceResult {
  state: TranscriptProjection;
  accepted: boolean;
  reason?: 'old-cursor' | 'duplicate-runtime-seq' | 'old-runtime-epoch';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function directString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === 'string' && value[key] ? value[key] : undefined;
}

/** Return the direct compatibility tool record without recursive provider scans. */
export function transcriptToolRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if ((value.type === 'tool' || value.kind === 'tool') && isRecord(value.tool))
    return value.tool;
  if (
    value.type === 'tool' ||
    value.kind === 'tool' ||
    value.type === 'toolCall' ||
    value.type === 'tool_call' ||
    value.role === 'toolResult' ||
    typeof value.toolName === 'string'
  )
    return value;
  return undefined;
}

/** Canonical activity outcome for raw compatibility tool records. */
export function transcriptToolOutcome(
  value: unknown,
): TranscriptActivityToolStatus {
  const tool = transcriptToolRecord(value);
  if (!tool) return 'pending';
  if (
    tool.error ||
    tool.isError === true ||
    tool.status === 'error' ||
    tool.status === 'failed'
  )
    return 'error';
  if (tool.status === 'running') return 'running';
  if (
    tool.isError === false ||
    typeof tool.result !== 'undefined' ||
    typeof tool.content !== 'undefined' ||
    tool.status === 'completed' ||
    tool.status === 'complete' ||
    tool.status === 'finished' ||
    tool.status === 'success'
  )
    return 'success';
  return 'pending';
}

function directToolCallParts(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) &&
        (part.type === 'toolCall' || part.type === 'tool_call'),
    )
    .slice(0, 128);
}

function directToolCallIds(content: unknown): string[] {
  const ids: string[] = [];
  for (const part of directToolCallParts(content)) {
    const id = directString(part, 'toolCallId') ?? directString(part, 'id');
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= 128) break;
  }
  return ids;
}

function mergeToolCallIds(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] | undefined {
  const ids = [...new Set([...(first ?? []), ...(second ?? [])])].slice(0, 128);
  return ids.length > 0 ? ids : undefined;
}

function asInput(
  input: DashboardEventEnvelope | TranscriptReducerEvent | BridgeEvent,
): TranscriptReducerEvent {
  if (
    typeof input === 'object' &&
    input !== null &&
    'event' in input &&
    typeof (input as { event?: unknown }).event === 'object'
  )
    return input as TranscriptReducerEvent;
  return { event: input as BridgeEvent };
}

export function createTranscriptProjection(
  sessionId?: string,
): TranscriptProjection {
  return {
    ...(sessionId ? { sessionId } : {}),
    order: [],
    items: {},
    lastCursor: -1,
    lastRuntimeSeq: -1,
    retiredEpochs: [],
  };
}
export const createTranscriptReducerState = createTranscriptProjection;

function normalizedMessage(
  value: unknown,
  projection: TranscriptProjection,
  phase: 'started' | 'updated' | 'finished',
): NormalizedMessagePayload | undefined {
  // One unwrap is allowed for v1 bridge wrappers. Deliberately do not search
  // arbitrary nested provider fields for identities.
  const direct = tryParseNormalizedMessagePayload(value);
  if (direct) {
    const toolCallIds = mergeToolCallIds(
      direct.toolCallIds,
      directToolCallIds(direct.content),
    );
    return toolCallIds === undefined ? direct : { ...direct, toolCallIds };
  }
  if (!isRecord(value)) return undefined;
  const wrapper = isRecord(value.message) ? value.message : value;
  const message = isRecord(wrapper.message) ? wrapper.message : wrapper;
  const normalized = tryParseNormalizedMessagePayload(message);
  if (normalized) {
    const toolCallIds = mergeToolCallIds(
      normalized.toolCallIds,
      directToolCallIds(normalized.content),
    );
    return toolCallIds === undefined
      ? normalized
      : { ...normalized, toolCallIds };
  }

  // Rollout compatibility for already-running protocol-v1 extensions. Remove
  // after old runtimes can no longer reconnect without explicit identities.
  const role = directString(message, 'role');
  if (!role || message.content === undefined) return undefined;
  const timestamp =
    message.timestamp ??
    wrapper.timestamp ??
    (value as Record<string, unknown>).timestamp;
  const explicitId =
    directString(message, 'messageId') ?? directString(message, 'id');
  const responseId =
    directString(value as Record<string, unknown>, 'responseId') ??
    directString(wrapper, 'responseId') ??
    directString(message, 'responseId');
  const activeId = [...projection.order].reverse().find((id) => {
    const item = projection.items[id];
    return (
      item?.kind === 'message' &&
      item.role === role &&
      item.status === 'streaming'
    );
  });
  const messageId =
    explicitId ??
    (phase !== 'started'
      ? (activeId ?? responseId)
      : (responseId ??
        (typeof timestamp === 'number' || typeof timestamp === 'string'
          ? `${role}:${timestamp}`
          : undefined)));
  if (!messageId) return undefined;
  return {
    messageId,
    role,
    content: message.content,
    ...(typeof timestamp === 'number' || typeof timestamp === 'string'
      ? { timestamp }
      : {}),
    ...(directToolCallIds(message.content).length > 0
      ? { toolCallIds: directToolCallIds(message.content) }
      : {}),
    phase,
  };
}

function normalizedToolStatus(
  value: unknown,
): NormalizedToolPayload['status'] | undefined {
  return value === 'pending' ||
    value === 'running' ||
    value === 'complete' ||
    value === 'completed' ||
    value === 'finished' ||
    value === 'success' ||
    value === 'error' ||
    value === 'failed'
    ? value
    : undefined;
}

function normalizedTool(value: unknown): NormalizedToolPayload | undefined {
  const direct = tryParseNormalizedToolPayload(value);
  if (direct) return direct;
  if (!isRecord(value)) return undefined;
  const tool = isRecord(value.tool) ? value.tool : value;
  const normalized = tryParseNormalizedToolPayload(tool);
  if (normalized) return normalized;
  const toolCallId =
    directString(tool, 'toolCallId') ?? directString(tool, 'id');
  if (!toolCallId) return undefined;
  const status = normalizedToolStatus(tool.status);
  return {
    toolCallId,
    name:
      directString(tool, 'toolName') ?? directString(tool, 'name') ?? 'tool',
    ...(tool.args === undefined ? {} : { arguments: tool.args }),
    ...(tool.arguments === undefined ? {} : { arguments: tool.arguments }),
    ...(tool.result === undefined ? {} : { result: tool.result }),
    ...(typeof tool.isError === 'boolean' ? { isError: tool.isError } : {}),
    ...(status === undefined ? {} : { status }),
  };
}

function phaseFor(type: string): 'started' | 'updated' | 'finished' {
  return type.endsWith('.started')
    ? 'started'
    : type.endsWith('.finished')
      ? 'finished'
      : 'updated';
}

function copyItems(
  projection: TranscriptProjection,
): Record<string, TranscriptItem> {
  return { ...projection.items };
}

function isFinished(item: TranscriptItem | undefined): boolean {
  return item?.kind === 'message'
    ? item.status === 'finished'
    : item?.kind === 'tool'
      ? item.status === 'finished' || item.status === 'error'
      : false;
}

function normalizedDeliveryMode(
  data: unknown,
): TranscriptDeliveryMode | undefined {
  if (!isRecord(data)) return undefined;
  return data.deliveryMode === 'steer' || data.deliveryMode === 'followUp'
    ? data.deliveryMode
    : undefined;
}

function mergeMessage(
  projection: TranscriptProjection,
  payload: NormalizedMessagePayload,
  phase: 'started' | 'updated' | 'finished',
): TranscriptProjection {
  const items = copyItems(projection);
  const previous = items[payload.messageId];
  // Finished and errored entities are terminal. A later lifecycle event can
  // have a newer transport cursor while still being stale for this item.
  if (previous && isFinished(previous)) return projection;
  const toolCallIds = mergeToolCallIds(
    previous?.kind === 'message' ? previous.toolCallIds : undefined,
    mergeToolCallIds(payload.toolCallIds, directToolCallIds(payload.content)),
  );
  const deliveryMode =
    normalizedDeliveryMode(payload.data) ??
    (previous?.kind === 'message' ? previous.deliveryMode : undefined);
  const previousData =
    previous?.kind === 'message' && isRecord(previous.data)
      ? previous.data
      : undefined;
  const payloadData = isRecord(payload.data) ? payload.data : undefined;
  const data =
    payload.role === 'custom' && previousData && payloadData
      ? { ...previousData, ...payloadData }
      : payload.data === undefined && previous?.kind === 'message'
        ? previous.data
        : payload.data;
  const item: TranscriptMessageItem = {
    kind: 'message',
    messageId: payload.messageId,
    role: payload.role,
    content: payload.content,
    ...(payload.timestamp === undefined
      ? {}
      : { timestamp: payload.timestamp }),
    ...(payload.turnId === undefined ? {} : { turnId: payload.turnId }),
    ...(toolCallIds === undefined ? {} : { toolCallIds }),
    ...(deliveryMode === undefined ? {} : { deliveryMode }),
    status:
      phase === 'finished'
        ? 'finished'
        : previous?.kind === 'message'
          ? previous.status
          : 'streaming',
    ...(data === undefined ? {} : { data }),
  };
  items[payload.messageId] = item;
  return {
    ...projection,
    order: previous
      ? projection.order
      : [...projection.order, payload.messageId],
    items,
  };
}

function mergeTool(
  projection: TranscriptProjection,
  payload: NormalizedToolPayload,
  phase: 'started' | 'updated' | 'finished',
): TranscriptProjection {
  const items = copyItems(projection);
  const previous = items[payload.toolCallId];
  // Finished and errored entities are terminal. In particular, a duplicate
  // finished event must not replace an earlier result or error.
  if (previous && isFinished(previous)) return projection;
  const previousTool = previous?.kind === 'tool' ? previous : undefined;
  const status: TranscriptEntityStatus =
    payload.isError === true ||
    payload.status === 'error' ||
    payload.status === 'failed'
      ? 'error'
      : phase === 'finished' ||
          payload.status === 'complete' ||
          payload.status === 'completed' ||
          payload.status === 'finished' ||
          payload.status === 'success'
        ? 'finished'
        : phase === 'started'
          ? 'pending'
          : 'running';
  const item: TranscriptToolItem = {
    kind: 'tool',
    toolCallId: payload.toolCallId,
    name: payload.name || previousTool?.name || 'tool',
    ...(payload.arguments === undefined
      ? previousTool?.arguments === undefined
        ? {}
        : { arguments: previousTool.arguments }
      : { arguments: payload.arguments }),
    ...(payload.result === undefined
      ? previousTool?.result === undefined
        ? {}
        : { result: previousTool.result }
      : { result: payload.result }),
    ...(payload.isError === undefined
      ? previousTool?.isError === undefined
        ? {}
        : { isError: previousTool.isError }
      : { isError: payload.isError }),
    status,
    ...(payload.turnId === undefined
      ? previousTool?.turnId === undefined
        ? {}
        : { turnId: previousTool.turnId }
      : { turnId: payload.turnId }),
    ...(payload.data === undefined
      ? previousTool?.data === undefined
        ? {}
        : { data: previousTool.data }
      : { data: payload.data }),
  };
  items[payload.toolCallId] = item;
  return {
    ...projection,
    order: previous
      ? projection.order
      : [...projection.order, payload.toolCallId],
    items,
  };
}

/** Apply one normalized live event without mutating the prior projection. */
export function applyTranscriptEvent(
  current: TranscriptProjection,
  input: DashboardEventEnvelope | TranscriptReducerEvent | BridgeEvent,
): TranscriptReduceResult {
  const incoming = asInput(input);
  const transport = applyTransportOrdering(current, incoming);
  if (!transport.accepted)
    return { state: current, accepted: false, reason: transport.reason };
  let state: TranscriptProjection = {
    ...current,
    ...transport.state,
    ...(transport.replacingEpoch
      ? { sessionId: undefined, order: [], items: {} }
      : {}),
  };
  const event = incoming.event;
  const eventSession =
    incoming.sessionId ??
    ('sessionId' in event ? event.sessionId : undefined) ??
    (event.type === 'session.changed' || event.type === 'session.snapshot'
      ? event.session.id
      : undefined);
  if (state.sessionId && eventSession && eventSession !== state.sessionId)
    return { state, accepted: true };
  if (!state.sessionId && eventSession)
    state = { ...state, sessionId: eventSession };
  if (event.type === 'session.snapshot') {
    if (
      (event.session as { entriesComplete?: boolean }).entriesComplete !== true
    )
      return {
        state: transport.replacingEpoch
          ? {
              ...state,
              sessionId: current.sessionId,
              order: current.order,
              items: current.items,
            }
          : state,
        accepted: true,
      };
    const replacement = hydrateTranscript(
      event.session.entries,
      event.session.id,
      {
        cursor: state.lastCursor,
        runtimeEpoch: state.runtimeEpoch,
        runtimeSeq: state.lastRuntimeSeq,
      },
    );
    return {
      state: { ...replacement, retiredEpochs: state.retiredEpochs },
      accepted: true,
    };
  }
  const phase = phaseFor(event.type);
  if (event.type.startsWith('message.')) {
    const payload = normalizedMessage(event, state, phase);
    if (!payload) return { state, accepted: true };
    // Pi emits toolResult message lifecycle events after the canonical
    // tool_execution lifecycle. Persisted hydration folds those records into
    // their tools, so retaining them as live messages would create opaque rows
    // and false activity-group boundaries until reload.
    if (payload.role === 'toolResult') return { state, accepted: true };
    return { state: mergeMessage(state, payload, phase), accepted: true };
  }
  if (event.type.startsWith('tool.')) {
    const payload = normalizedTool('tool' in event ? event.tool : undefined);
    if (!payload) return { state, accepted: true };
    return { state: mergeTool(state, payload, phase), accepted: true };
  }
  return { state, accepted: true };
}

export function reduceTranscriptEvent(
  current: TranscriptProjection,
  input: DashboardEventEnvelope | TranscriptReducerEvent | BridgeEvent,
): TranscriptProjection {
  return applyTranscriptEvent(current, input).state;
}
export const transcriptReducer = reduceTranscriptEvent;
export const reduceTranscript = reduceTranscriptEvent;

function persistedMessage(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (isRecord(entry.message)) return entry.message;
  // Session history also contains unwrapped Pi messages. Keep this gate
  // deliberately narrow: only the known message roles cross the compatibility
  // boundary; unrelated raw entries remain opaque below.
  if (
    entry.type === undefined &&
    (entry.role === 'assistant' ||
      entry.role === 'user' ||
      entry.role === 'toolResult')
  )
    return entry;
  return undefined;
}

function persistedEntryId(entry: Record<string, unknown>): string | undefined {
  return directString(entry, 'id');
}

function persistedMessageId(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  return (
    directString(message, 'messageId') ??
    directString(message, 'id') ??
    persistedEntryId(entry)
  );
}

function timestampKey(value: number | string): string {
  return `${typeof value}:${value}`;
}

function messageContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(messageContentText).join('');
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  return value.content === undefined ? '' : messageContentText(value.content);
}

function isSteeringMarkerEntry(entry: Record<string, unknown>): boolean {
  return (
    entry.type === 'custom' && entry.customType === STEERING_MESSAGE_MARKER_TYPE
  );
}

function steeringMarkerData(
  entry: Record<string, unknown>,
): { timestamp: number | string; text: string } | undefined {
  if (!isSteeringMarkerEntry(entry) || !isRecord(entry.data)) return undefined;
  const timestamp = entry.data.timestamp;
  const text = entry.data.text;
  return (typeof timestamp === 'number' || typeof timestamp === 'string') &&
    typeof text === 'string'
    ? { timestamp, text }
    : undefined;
}

function steeringMarkerKey(timestamp: number | string, text: string): string {
  return `${timestampKey(timestamp)}:${text.length}:${text}`;
}

function steeringMarkers(entries: readonly unknown[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of entries) {
    if (!isRecord(value)) continue;
    const marker = steeringMarkerData(value);
    if (marker) result.add(steeringMarkerKey(marker.timestamp, marker.text));
  }
  return result;
}

function persistedTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number | string | undefined {
  const value = message.timestamp ?? entry.timestamp;
  return typeof value === 'number' || typeof value === 'string'
    ? value
    : undefined;
}

function persistedToolStatus(
  tool: Record<string, unknown>,
): Exclude<TranscriptEntityStatus, 'streaming'> {
  const outcome = transcriptToolOutcome(tool);
  if (outcome === 'error') return 'error';
  if (outcome === 'running') return 'running';
  if (outcome === 'success') return 'finished';
  return 'pending';
}

/**
 * Hydrate Pi JSONL entries. Only explicit entry/message/tool IDs and direct
 * timestamps are used; arbitrary recursive provider fields are not identities.
 * `fallbackEntryIds` is a compatibility mode for the public web adapter: it
 * preserves its stable entry-N keys for otherwise opaque message records.
 */
export function hydrateTranscript(
  entries: readonly unknown[],
  sessionId?: string,
  options: {
    cursor?: number;
    runtimeEpoch?: string;
    runtimeSeq?: number;
    fallbackEntryIds?: boolean;
    /** Absolute logical entry ordinal used for page-local fallback identities. */
    fallbackEntryOffset?: number;
  } = {},
): TranscriptProjection {
  let projection = createTranscriptProjection(sessionId);
  const items = copyItems(projection);
  const fallbackEntryId = (index: number) =>
    `entry-${(options.fallbackEntryOffset ?? 0) + index}`;
  const order = [...projection.order];
  const markedSteeringMarkers = steeringMarkers(entries);
  entries.forEach((raw, index) => {
    if (!isRecord(raw)) {
      const id = fallbackEntryId(index);
      items[id] = { kind: 'other', id, raw };
      order.push(id);
      return;
    }
    const message = persistedMessage(raw);
    if (message && (raw.type === 'message' || raw.type === undefined)) {
      const messageId =
        persistedMessageId(raw, message) ??
        (options.fallbackEntryIds ? fallbackEntryId(index) : undefined);
      if (!messageId) {
        const id = fallbackEntryId(index);
        items[id] = { kind: 'other', id, raw };
        order.push(id);
        return;
      }
      const role = typeof message.role === 'string' ? message.role : 'unknown';
      const timestamp = persistedTimestamp(raw, message);
      if (role === 'toolResult') {
        const toolCallId = directString(message, 'toolCallId');
        if (toolCallId) {
          const existing = items[toolCallId];
          if (existing?.kind === 'tool') {
            items[toolCallId] = {
              ...existing,
              result: message.content,
              ...(typeof message.isError === 'boolean'
                ? { isError: message.isError }
                : {}),
              status: message.isError === true ? 'error' : 'finished',
            };
          } else {
            items[toolCallId] = {
              kind: 'tool',
              toolCallId,
              name: 'tool',
              result: message.content,
              ...(typeof message.isError === 'boolean'
                ? { isError: message.isError }
                : {}),
              status: message.isError === true ? 'error' : 'finished',
            };
            order.push(toolCallId);
          }
        }
        return;
      }
      const content = message.content;
      const deliveryMode =
        role === 'user' &&
        timestamp !== undefined &&
        markedSteeringMarkers.has(
          steeringMarkerKey(timestamp, messageContentText(content)),
        )
          ? ('steer' as const)
          : undefined;
      const explicitToolCallIds = Array.isArray(message.toolCallIds)
        ? message.toolCallIds.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          )
        : [];
      const toolCallIds =
        mergeToolCallIds(explicitToolCallIds, directToolCallIds(content)) ?? [];
      items[messageId] = {
        kind: 'message',
        messageId,
        role,
        content,
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
        ...(deliveryMode === undefined ? {} : { deliveryMode }),
        status:
          message.__dashboardStreaming === true ? 'streaming' : 'finished',
      };
      if (!order.includes(messageId)) order.push(messageId);
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            !isRecord(part) ||
            (part.type !== 'toolCall' && part.type !== 'tool_call')
          )
            continue;
          const toolCallId =
            directString(part, 'toolCallId') ?? directString(part, 'id');
          if (!toolCallId) continue;
          const existingTool =
            items[toolCallId]?.kind === 'tool'
              ? (items[toolCallId] as TranscriptToolItem)
              : undefined;
          items[toolCallId] = {
            kind: 'tool',
            toolCallId,
            name:
              directString(part, 'name') ??
              directString(part, 'toolName') ??
              existingTool?.name ??
              'tool',
            ...(part.arguments === undefined && part.args === undefined
              ? existingTool?.arguments === undefined
                ? {}
                : { arguments: existingTool.arguments }
              : {
                  arguments:
                    part.arguments === undefined ? part.args : part.arguments,
                }),
            ...(part.result === undefined
              ? existingTool?.result === undefined
                ? {}
                : { result: existingTool.result }
              : { result: part.result }),
            ...(part.isError === undefined
              ? existingTool?.isError === undefined
                ? {}
                : { isError: existingTool.isError }
              : typeof part.isError === 'boolean'
                ? { isError: part.isError }
                : {}),
            status: existingTool?.status ?? persistedToolStatus(part),
            ...(existingTool?.turnId === undefined
              ? {}
              : { turnId: existingTool.turnId }),
            ...(existingTool?.data === undefined
              ? {}
              : { data: existingTool.data }),
          };
          if (!order.includes(toolCallId)) order.push(toolCallId);
        }
      }
      return;
    }
    if (isSteeringMarkerEntry(raw)) return;
    const tool =
      raw.type === 'tool' || raw.kind === 'tool'
        ? transcriptToolRecord(raw)
        : undefined;
    if (tool) {
      const toolCallId =
        directString(tool, 'toolCallId') ?? directString(tool, 'id');
      if (toolCallId) {
        items[toolCallId] = {
          kind: 'tool',
          toolCallId,
          name:
            directString(tool, 'name') ??
            directString(tool, 'toolName') ??
            'tool',
          ...(tool.arguments === undefined && tool.args === undefined
            ? {}
            : {
                arguments:
                  tool.arguments === undefined ? tool.args : tool.arguments,
              }),
          ...(tool.result === undefined ? {} : { result: tool.result }),
          status: persistedToolStatus(tool),
          ...(typeof tool.isError === 'boolean'
            ? { isError: tool.isError }
            : {}),
          ...(tool.data === undefined ? {} : { data: tool.data }),
        };
        if (!order.includes(toolCallId)) order.push(toolCallId);
        return;
      }
    }
    const id = persistedEntryId(raw) ?? fallbackEntryId(index);
    items[id] = { kind: 'other', id, raw };
    if (!order.includes(id)) order.push(id);
  });
  projection = {
    ...projection,
    order,
    items,
    ...(options.cursor === undefined ? {} : { lastCursor: options.cursor }),
    ...(options.runtimeEpoch === undefined
      ? {}
      : { runtimeEpoch: options.runtimeEpoch }),
    ...(options.runtimeSeq === undefined
      ? {}
      : { lastRuntimeSeq: options.runtimeSeq }),
  };
  return projection;
}
export const hydrateTranscriptProjection = hydrateTranscript;

const NON_RENDERED_PI_ENTRY_TYPES = new Set([
  'session',
  'model_change',
  'thinking_level_change',
  'compaction',
  'branch_summary',
  'label',
  'session_info',
]);

function isNonRenderedPiEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    NON_RENDERED_PI_ENTRY_TYPES.has(value.type)
  );
}

function renderedMessageContent(
  item: TranscriptMessageItem,
  projection: TranscriptProjection,
  virtualToolCallIds: ReadonlySet<string> = new Set(),
): unknown {
  // Tool calls are normalized as standalone projection items. Remove only
  // embedded calls that have a matching semantic item so renderers cannot
  // display the same call twice.
  if (!Array.isArray(item.content)) return item.content;
  return item.content.filter((part) => {
    if (!isRecord(part)) return true;
    if (part.type !== 'toolCall' && part.type !== 'tool_call') return true;
    const toolCallId =
      directString(part, 'toolCallId') ?? directString(part, 'id');
    return (
      !toolCallId ||
      (projection.items[toolCallId]?.kind !== 'tool' &&
        !virtualToolCallIds.has(toolCallId))
    );
  });
}

function renderToolStatus(
  status: TranscriptEntityStatus,
): TranscriptActivityToolStatus {
  if (status === 'error') return 'error';
  if (status === 'running') return 'running';
  if (status === 'finished') return 'success';
  return 'pending';
}

/**
 * Project the reducer-owned transcript into renderer/activity semantics. This
 * is the single place where domain entity status and tool associations become
 * render status and streaming/preparing flags.
 */
export function projectTranscriptForRender(
  projection: TranscriptProjection,
  options: {
    includePendingEmbeddedToolCalls?: boolean;
    includeSessionEvents?: boolean;
  } = {},
): TranscriptRenderProjection {
  const includePendingEmbeddedToolCalls =
    options.includePendingEmbeddedToolCalls !== false;
  const items: TranscriptRenderItem[] = [];
  const virtualToolCallIds = new Set<string>();
  const renderedVirtualToolCallIds = new Set<string>();
  for (const id of projection.order) {
    const item = projection.items[id];
    if (!item) continue;
    if (item.kind === 'other') {
      if (options.includeSessionEvents || !isNonRenderedPiEntry(item.raw))
        items.push({ kind: 'other', key: item.id, id: item.id, raw: item.raw });
      continue;
    }
    if (item.kind === 'message') {
      const messageData = isRecord(item.data) ? item.data : undefined;
      const customType =
        item.role === 'custom' && messageData
          ? directString(messageData, 'customType')
          : undefined;
      if (customType) {
        items.push({
          kind: 'other',
          key: item.messageId,
          id: item.messageId,
          raw: {
            type: 'custom_message',
            customType,
            content: item.content,
            ...(typeof messageData?.display === 'boolean'
              ? { display: messageData.display }
              : {}),
            ...(messageData?.details === undefined
              ? {}
              : { details: messageData.details }),
          },
        });
        continue;
      }
      const embeddedToolCalls = directToolCallParts(item.content);
      const embeddedToolCallIds = embeddedToolCalls
        .map(
          (part) =>
            directString(part, 'toolCallId') ?? directString(part, 'id'),
        )
        .filter((toolCallId): toolCallId is string => toolCallId !== undefined);
      const toolCallIds =
        mergeToolCallIds(item.toolCallIds, embeddedToolCallIds) ?? [];
      if (includePendingEmbeddedToolCalls)
        for (const toolCallId of embeddedToolCallIds)
          if (projection.items[toolCallId]?.kind !== 'tool')
            virtualToolCallIds.add(toolCallId);
      const associatedToolCallIds = toolCallIds.filter(
        (toolCallId) =>
          projection.items[toolCallId]?.kind === 'tool' ||
          virtualToolCallIds.has(toolCallId),
      );
      items.push({
        kind: 'message',
        key: item.messageId,
        messageId: item.messageId,
        role: item.role,
        content: renderedMessageContent(item, projection, virtualToolCallIds),
        ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
        ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
        ...(item.deliveryMode === undefined
          ? {}
          : { deliveryMode: item.deliveryMode }),
        toolCallIds,
        associatedToolCallIds,
        status: item.status,
        streaming: item.status === 'streaming',
        preparing:
          item.status === 'streaming' && associatedToolCallIds.length === 0,
      });
      for (const part of includePendingEmbeddedToolCalls
        ? embeddedToolCalls
        : []) {
        const toolCallId =
          directString(part, 'toolCallId') ?? directString(part, 'id');
        if (!toolCallId || projection.items[toolCallId]?.kind === 'tool')
          continue;
        if (renderedVirtualToolCallIds.has(toolCallId)) continue;
        renderedVirtualToolCallIds.add(toolCallId);
        items.push({
          kind: 'tool',
          key: toolCallId,
          toolCallId,
          name:
            directString(part, 'name') ??
            directString(part, 'toolName') ??
            'tool',
          ...(part.arguments === undefined && part.args === undefined
            ? {}
            : {
                arguments:
                  part.arguments === undefined ? part.args : part.arguments,
              }),
          ...(part.result === undefined ? {} : { result: part.result }),
          ...(typeof part.isError === 'boolean'
            ? { isError: part.isError }
            : {}),
          status: renderToolStatus(persistedToolStatus(part)),
        });
      }
      continue;
    }
    items.push({
      kind: 'tool',
      key: item.toolCallId,
      toolCallId: item.toolCallId,
      name: item.name,
      ...(item.arguments === undefined ? {} : { arguments: item.arguments }),
      ...(item.result === undefined ? {} : { result: item.result }),
      ...(item.isError === undefined ? {} : { isError: item.isError }),
      status: renderToolStatus(item.status),
      ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
      ...(item.data === undefined ? {} : { data: item.data }),
    });
  }
  return {
    ...(projection.sessionId === undefined
      ? {}
      : { sessionId: projection.sessionId }),
    items,
  };
}

export function selectTranscriptRenderItems(
  projection: TranscriptProjection,
): readonly TranscriptRenderItem[] {
  return projectTranscriptForRender(projection).items;
}

/** Existing dashboard UI compatibility selector; no transport logic lives here. */
export function selectLegacyTranscriptEntries(
  projection: TranscriptProjection,
): unknown[] {
  return projectTranscriptForRender(projection, {
    includePendingEmbeddedToolCalls: false,
  }).items.map((item) => {
    if (item.kind === 'other') return item.raw;
    if (item.kind === 'message')
      return {
        type: 'message',
        message: {
          id: item.messageId,
          messageId: item.messageId,
          role: item.role,
          content: item.content,
          ...(item.timestamp === undefined
            ? {}
            : { timestamp: item.timestamp }),
          ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
          ...(item.deliveryMode === undefined
            ? {}
            : { deliveryMode: item.deliveryMode }),
          ...(item.toolCallIds.length === 0
            ? {}
            : { toolCallIds: item.toolCallIds }),
          ...(item.streaming ? { __dashboardStreaming: true } : {}),
        },
      };
    return {
      type: 'tool',
      tool: {
        toolCallId: item.toolCallId,
        id: item.toolCallId,
        name: item.name,
        ...(item.arguments === undefined ? {} : { arguments: item.arguments }),
        ...(item.result === undefined ? {} : { result: item.result }),
        ...(item.isError === undefined ? {} : { isError: item.isError }),
        status:
          item.status === 'success'
            ? 'finished'
            : item.status === 'error'
              ? 'error'
              : item.status,
      },
    };
  });
}
export const selectLegacyRawEntries = selectLegacyTranscriptEntries;
export const toLegacyTranscriptEntries = selectLegacyTranscriptEntries;
export const compatibilityTranscriptEntries = selectLegacyTranscriptEntries;
