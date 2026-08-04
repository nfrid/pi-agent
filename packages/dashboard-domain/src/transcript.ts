import type {
  BridgeEvent,
  DashboardEventEnvelope,
  NormalizedMessagePayload,
  NormalizedToolPayload,
} from '@pi-dashboard/protocol';
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

export interface TranscriptMessageItem {
  kind: 'message';
  messageId: string;
  role: string;
  content: unknown;
  timestamp?: number | string;
  turnId?: string;
  toolCallIds?: readonly string[];
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
  if (direct) return direct;
  if (!isRecord(value)) return undefined;
  const message = isRecord(value.message) ? value.message : value;
  const normalized = tryParseNormalizedMessagePayload(message);
  if (normalized) return normalized;

  // Rollout compatibility for already-running protocol-v1 extensions. Remove
  // after old runtimes can no longer reconnect without explicit identities.
  const role = directString(message, 'role');
  if (!role || message.content === undefined) return undefined;
  const timestamp = message.timestamp;
  const explicitId =
    directString(message, 'messageId') ??
    directString(message, 'id') ??
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
    (typeof timestamp === 'number' || typeof timestamp === 'string'
      ? `${role}:${timestamp}`
      : phase === 'started'
        ? undefined
        : activeId);
  if (!messageId) return undefined;
  return {
    messageId,
    role,
    content: message.content,
    ...(typeof timestamp === 'number' || typeof timestamp === 'string'
      ? { timestamp }
      : {}),
    phase,
  };
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
  return {
    toolCallId,
    name:
      directString(tool, 'toolName') ?? directString(tool, 'name') ?? 'tool',
    ...(tool.args === undefined ? {} : { arguments: tool.args }),
    ...(tool.arguments === undefined ? {} : { arguments: tool.arguments }),
    ...(tool.result === undefined ? {} : { result: tool.result }),
    ...(typeof tool.isError === 'boolean' ? { isError: tool.isError } : {}),
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
  const item: TranscriptMessageItem = {
    kind: 'message',
    messageId: payload.messageId,
    role: payload.role,
    content: payload.content,
    ...(payload.timestamp === undefined
      ? {}
      : { timestamp: payload.timestamp }),
    ...(payload.turnId === undefined ? {} : { turnId: payload.turnId }),
    ...(payload.toolCallIds === undefined
      ? {}
      : { toolCallIds: payload.toolCallIds }),
    status:
      phase === 'finished'
        ? 'finished'
        : previous?.kind === 'message'
          ? previous.status
          : 'streaming',
    ...(payload.data === undefined ? {} : { data: payload.data }),
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
          payload.status === 'completed' ||
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

function transportState(
  current: TranscriptProjection,
  incoming: TranscriptReducerEvent,
): {
  projection: TranscriptProjection;
  accepted: boolean;
  reason?: TranscriptReduceResult['reason'];
  replacingEpoch: boolean;
} {
  if (incoming.cursor !== undefined && incoming.cursor <= current.lastCursor)
    return {
      projection: current,
      accepted: false,
      reason: 'old-cursor',
      replacingEpoch: false,
    };
  const epoch = incoming.runtimeEpoch;
  let runtimeEpoch = current.runtimeEpoch;
  let retiredEpochs = current.retiredEpochs;
  let replacingEpoch = false;
  if (
    epoch !== undefined &&
    current.runtimeEpoch !== undefined &&
    epoch !== current.runtimeEpoch
  ) {
    if (current.retiredEpochs.includes(epoch))
      return {
        projection: current,
        accepted: false,
        reason: 'old-runtime-epoch',
        replacingEpoch: false,
      };
    replacingEpoch = true;
    retiredEpochs = [...current.retiredEpochs, current.runtimeEpoch];
    runtimeEpoch = epoch;
  } else if (epoch !== undefined && current.runtimeEpoch === undefined)
    runtimeEpoch = epoch;
  if (
    !replacingEpoch &&
    epoch !== undefined &&
    current.retiredEpochs.includes(epoch)
  )
    return {
      projection: current,
      accepted: false,
      reason: 'old-runtime-epoch',
      replacingEpoch: false,
    };
  if (
    !replacingEpoch &&
    incoming.runtimeSeq !== undefined &&
    incoming.runtimeSeq <= current.lastRuntimeSeq
  )
    return {
      projection: current,
      accepted: false,
      reason: 'duplicate-runtime-seq',
      replacingEpoch: false,
    };
  return {
    projection: {
      ...current,
      ...(replacingEpoch ? { sessionId: undefined, order: [], items: {} } : {}),
      runtimeEpoch,
      retiredEpochs,
      lastCursor: incoming.cursor ?? current.lastCursor,
      lastRuntimeSeq: replacingEpoch
        ? (incoming.runtimeSeq ?? -1)
        : (incoming.runtimeSeq ?? current.lastRuntimeSeq),
    },
    accepted: true,
    replacingEpoch,
  };
}

/** Apply one normalized live event without mutating the prior projection. */
export function applyTranscriptEvent(
  current: TranscriptProjection,
  input: DashboardEventEnvelope | TranscriptReducerEvent | BridgeEvent,
): TranscriptReduceResult {
  const incoming = asInput(input);
  const transport = transportState(current, incoming);
  if (!transport.accepted)
    return { state: current, accepted: false, reason: transport.reason };
  let state = transport.projection;
  const event = incoming.event;
  const eventSession =
    incoming.sessionId ?? ('sessionId' in event ? event.sessionId : undefined);
  if (state.sessionId && eventSession && eventSession !== state.sessionId)
    return { state, accepted: true };
  if (!state.sessionId && eventSession)
    state = { ...state, sessionId: eventSession };
  const phase = phaseFor(event.type);
  if (event.type.startsWith('message.')) {
    const payload = normalizedMessage(
      'message' in event ? event.message : undefined,
      state,
      phase,
    );
    if (!payload) return { state, accepted: true };
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
  return isRecord(entry.message) ? entry.message : undefined;
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

function persistedTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number | string | undefined {
  const value = message.timestamp ?? entry.timestamp;
  return typeof value === 'number' || typeof value === 'string'
    ? value
    : undefined;
}

/**
 * Hydrate Pi JSONL entries. Only explicit entry/message/tool IDs and direct
 * timestamps are used; arbitrary recursive provider fields are not identities.
 */
export function hydrateTranscript(
  entries: readonly unknown[],
  sessionId?: string,
  options: { cursor?: number; runtimeEpoch?: string; runtimeSeq?: number } = {},
): TranscriptProjection {
  let projection = createTranscriptProjection(sessionId);
  const items = copyItems(projection);
  const order = [...projection.order];
  entries.forEach((raw, index) => {
    if (!isRecord(raw)) {
      const id = `entry-${index}`;
      items[id] = { kind: 'other', id, raw };
      order.push(id);
      return;
    }
    const message = persistedMessage(raw);
    if (raw.type === 'message' && message) {
      const messageId = persistedMessageId(raw, message);
      if (!messageId) {
        const id = `entry-${index}`;
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
      items[messageId] = {
        kind: 'message',
        messageId,
        role,
        content,
        ...(timestamp === undefined ? {} : { timestamp }),
        status: 'finished',
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
            ...(part.arguments === undefined
              ? existingTool?.arguments === undefined
                ? {}
                : { arguments: existingTool.arguments }
              : { arguments: part.arguments }),
            ...(existingTool?.result === undefined
              ? {}
              : { result: existingTool.result }),
            ...(existingTool?.isError === undefined
              ? {}
              : { isError: existingTool.isError }),
            status: existingTool?.status ?? 'pending',
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
    if (raw.type === 'tool' && isRecord(raw.tool)) {
      const tool = raw.tool;
      const toolCallId = directString(tool, 'toolCallId');
      if (toolCallId) {
        items[toolCallId] = {
          kind: 'tool',
          toolCallId,
          name:
            directString(tool, 'name') ??
            directString(tool, 'toolName') ??
            'tool',
          ...(tool.arguments === undefined
            ? {}
            : { arguments: tool.arguments }),
          ...(tool.result === undefined ? {} : { result: tool.result }),
          status:
            tool.isError === true
              ? 'error'
              : tool.result === undefined
                ? 'pending'
                : 'finished',
          ...(typeof tool.isError === 'boolean'
            ? { isError: tool.isError }
            : {}),
        };
        if (!order.includes(toolCallId)) order.push(toolCallId);
        return;
      }
    }
    const id = persistedEntryId(raw) ?? `entry-${index}`;
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

/** Existing dashboard UI compatibility selector; no transport logic lives here. */
export function selectLegacyTranscriptEntries(
  projection: TranscriptProjection,
): unknown[] {
  return projection.order.flatMap((id) => {
    const item = projection.items[id];
    if (!item) return [];
    if (item.kind === 'other') return [item.raw];
    if (item.kind === 'message') {
      // Tool calls are normalized as standalone projection items. Remove only
      // embedded calls that have a matching semantic item so compatibility
      // rendering cannot display the same call twice.
      const content = Array.isArray(item.content)
        ? item.content.filter((part) => {
            if (!isRecord(part)) return true;
            if (part.type !== 'toolCall' && part.type !== 'tool_call')
              return true;
            const toolCallId =
              directString(part, 'toolCallId') ?? directString(part, 'id');
            return !toolCallId || projection.items[toolCallId]?.kind !== 'tool';
          })
        : item.content;
      return [
        {
          type: 'message',
          message: {
            id: item.messageId,
            messageId: item.messageId,
            role: item.role,
            content,
            ...(item.timestamp === undefined
              ? {}
              : { timestamp: item.timestamp }),
            ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
            ...(item.toolCallIds === undefined
              ? {}
              : { toolCallIds: item.toolCallIds }),
            ...(item.status === 'streaming'
              ? { __dashboardStreaming: true }
              : {}),
          },
        },
      ];
    }
    return [
      {
        type: 'tool',
        tool: {
          toolCallId: item.toolCallId,
          id: item.toolCallId,
          name: item.name,
          ...(item.arguments === undefined
            ? {}
            : { arguments: item.arguments }),
          ...(item.result === undefined ? {} : { result: item.result }),
          ...(item.isError === undefined ? {} : { isError: item.isError }),
          status: item.status,
        },
      },
    ];
  });
}
export const selectLegacyRawEntries = selectLegacyTranscriptEntries;
export const toLegacyTranscriptEntries = selectLegacyTranscriptEntries;
export const compatibilityTranscriptEntries = selectLegacyTranscriptEntries;
