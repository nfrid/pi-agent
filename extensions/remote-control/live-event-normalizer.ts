import { randomUUID } from 'node:crypto';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import {
  type BridgeEvent,
  MAX_FRAME_BYTES,
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_ARGUMENT_DELTA,
  type NormalizedMessagePayload,
  type NormalizedToolPayload,
} from '@pi-dashboard/protocol/pi-runtime-protocol';
import { jsonSafe } from './json-safe';

type EventRecord = Record<string, unknown>;

export function eventRecord(value: unknown): EventRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as EventRecord)
    : {};
}

export function withoutOpaqueData(event: BridgeEvent): BridgeEvent {
  if (event.type.startsWith('message.') && 'message' in event) {
    const message = event.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const { data, ...canonical } = message as Record<string, unknown>;
      const metadata = eventRecord(data);
      const deliveryMode = directString(metadata, 'deliveryMode');
      const customType = directString(metadata, 'customType');
      const customData =
        canonical.role === 'custom' &&
        (customType ||
          typeof metadata.display === 'boolean' ||
          metadata.details !== undefined)
          ? {
              ...(customType ? { customType } : {}),
              ...(typeof metadata.display === 'boolean'
                ? { display: metadata.display }
                : {}),
              ...(metadata.details === undefined
                ? {}
                : { details: metadata.details }),
            }
          : undefined;
      const allowlistedData = {
        ...(deliveryMode === 'steer' ? { deliveryMode: 'steer' as const } : {}),
        ...(customData ?? {}),
      };
      return {
        ...event,
        message: {
          ...canonical,
          ...(deliveryMode === 'steer' || customData
            ? { data: allowlistedData }
            : {}),
        },
      };
    }
  }
  if (event.type.startsWith('tool.') && 'tool' in event) {
    const tool = event.tool;
    if (tool && typeof tool === 'object' && !Array.isArray(tool)) {
      const { data: _data, ...canonical } = tool as Record<string, unknown>;
      return { ...event, tool: canonical };
    }
  }
  return event;
}

export function directValue(record: EventRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function directString(
  record: EventRecord,
  key: string,
): string | undefined {
  const value = directValue(record, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Tool execution events already carry the canonical live result. Forwarding
 * Pi's later toolResult message as a second transcript entity would duplicate
 * the tool and introduce a false activity-group boundary.
 */
export function shouldForwardLiveMessage(value: unknown): boolean {
  const event = eventRecord(value);
  const message = eventRecord(directValue(event, 'message'));
  const role = directString(message, 'role') ?? directString(event, 'role');
  if (role === 'toolResult') return false;
  if (role !== 'custom') return true;
  const messageData = eventRecord(directValue(message, 'data'));
  const eventData = eventRecord(directValue(event, 'data'));
  const display =
    directValue(message, 'display') ??
    directValue(event, 'display') ??
    directValue(messageData, 'display') ??
    directValue(eventData, 'display');
  if (display === false) return false;
  const content =
    directValue(message, 'content') ?? directValue(event, 'content');
  return !(
    typeof content === 'string' &&
    content.startsWith('Todo state at the start of this user turn (')
  );
}

function directIdentifier(
  record: EventRecord,
  key: string,
): string | number | undefined {
  const value = directValue(record, key);
  return (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

function safeIdentityPart(value: string | number): string {
  return Array.from(String(value), (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? '?' : character;
  })
    .join('')
    .slice(0, 240);
}

function textBlockAt(content: unknown, contentIndex: number): unknown {
  if (!Array.isArray(content)) return undefined;
  return content[contentIndex];
}

function setTextBlock(
  content: unknown,
  contentIndex: number,
  text: string,
): unknown {
  if (typeof content === 'string' && contentIndex === 0) return text;
  const next = Array.isArray(content) ? [...content] : [];
  next[contentIndex] = { type: 'text', text };
  return next;
}

function textEventContent(
  previous: unknown,
  contentIndex: number,
  delta: string,
  mode: 'start' | 'delta' | 'end',
): unknown {
  if (mode === 'start') return setTextBlock(previous, contentIndex, '');
  if (mode === 'end') return setTextBlock(previous, contentIndex, delta);

  if (typeof previous === 'string' && contentIndex === 0)
    return `${previous}${delta}`;
  const block = textBlockAt(previous, contentIndex);
  const currentText =
    block && typeof block === 'object' && !Array.isArray(block)
      ? (block as Record<string, unknown>).text
      : undefined;
  if (
    Array.isArray(previous) &&
    block !== undefined &&
    typeof currentText !== 'string'
  )
    return previous;
  return setTextBlock(
    previous,
    contentIndex,
    `${typeof currentText === 'string' ? currentText : ''}${delta}`,
  );
}

function thinkingBlockAt(content: unknown, contentIndex: number): string {
  const block = textBlockAt(content, contentIndex);
  if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
  const thinking = (block as Record<string, unknown>).thinking;
  return typeof thinking === 'string' ? thinking : '';
}

function setThinkingBlock(
  content: unknown,
  contentIndex: number,
  thinking: string,
): unknown {
  const next = Array.isArray(content) ? [...content] : [];
  next[contentIndex] = { type: 'thinking', thinking };
  return next;
}

/**
 * Apply visible text immediately, but expose thinking only through its latest
 * completed newline. GPT-family models use these lines as public activity
 * titles; retaining the trailing fragment avoids streaming partial titles.
 * Tool-call streams remain separate from assistant transcript content, and the
 * message_end wrapper remains the authoritative final assistant message.
 */
function applyAssistantMessageEvent(
  previous: unknown,
  event: AssistantMessageEvent,
  pendingThinking: Map<number, string>,
): unknown {
  switch (event.type) {
    case 'text_start':
      return textEventContent(previous, event.contentIndex, '', 'start');
    case 'text_delta':
      return textEventContent(
        previous,
        event.contentIndex,
        event.delta,
        'delta',
      );
    case 'text_end':
      return textEventContent(
        previous,
        event.contentIndex,
        event.content,
        'end',
      );
    case 'thinking_start':
      pendingThinking.set(event.contentIndex, '');
      return previous;
    case 'thinking_delta': {
      const buffered = `${pendingThinking.get(event.contentIndex) ?? ''}${event.delta}`;
      const boundary = buffered.lastIndexOf('\n');
      if (boundary < 0) {
        pendingThinking.set(event.contentIndex, buffered);
        return previous;
      }
      pendingThinking.set(event.contentIndex, buffered.slice(boundary + 1));
      return setThinkingBlock(
        previous,
        event.contentIndex,
        `${thinkingBlockAt(previous, event.contentIndex)}${buffered.slice(0, boundary + 1)}`,
      );
    }
    case 'thinking_end':
      pendingThinking.delete(event.contentIndex);
      return setThinkingBlock(previous, event.contentIndex, event.content);
    case 'toolcall_start':
    case 'toolcall_delta':
    case 'toolcall_end':
    case 'start':
    case 'done':
    case 'error':
      return previous;
  }
}

/**
 * Converts Pi's live event wrappers to the protocol's explicit live payloads.
 * Identity lookup intentionally only examines documented, named wrapper fields;
 * provider data is opaque and is never searched recursively for IDs.
 */
export class LiveEventNormalizer {
  private identitySequence = 0;
  private activeMessage:
    | {
        messageId: string;
        identityKey?: string;
        content?: unknown;
        pendingThinking: Map<number, string>;
      }
    | undefined;
  private readonly activeToolNames = new Map<string, string>();
  private readonly partialToolCalls = new Map<
    number,
    {
      toolCallId: string;
      name: string;
      pendingDelta: string;
      chars: number;
      lines: number;
      escapePending: boolean;
    }
  >();

  constructor(private readonly runtimeEpoch: string = randomUUID()) {}

  reset(): void {
    this.activeMessage = undefined;
    this.activeToolNames.clear();
    this.partialToolCalls.clear();
  }

  normalizeMessage(
    phase: 'started' | 'updated' | 'finished',
    value: unknown,
  ): NormalizedMessagePayload {
    const event = eventRecord(value);
    const message = eventRecord(directValue(event, 'message'));
    const assistantEventValue = directValue(event, 'assistantMessageEvent');
    const assistantEvent = eventRecord(assistantEventValue);
    const responseId =
      directIdentifier(event, 'responseId') ??
      directIdentifier(message, 'responseId') ??
      directIdentifier(assistantEvent, 'responseId');
    const timestamp =
      directIdentifier(event, 'timestamp') ??
      directIdentifier(message, 'timestamp');
    const identityKey =
      responseId !== undefined
        ? `response:${safeIdentityPart(responseId)}`
        : timestamp !== undefined
          ? `timestamp:${safeIdentityPart(timestamp)}`
          : undefined;

    let messageId: string;
    if (phase === 'started') {
      this.partialToolCalls.clear();
      messageId = identityKey
        ? identityKey
        : `${this.runtimeEpoch}:${++this.identitySequence}`;
      this.activeMessage = {
        messageId,
        identityKey,
        pendingThinking: new Map(),
      };
    } else if (this.activeMessage) {
      // A responseId is often only present on the final message wrapper. The
      // live ID established by start remains authoritative for this stream.
      messageId = this.activeMessage.messageId;
      this.activeMessage.identityKey ??= identityKey;
    } else {
      messageId = identityKey
        ? identityKey
        : `${this.runtimeEpoch}:${++this.identitySequence}`;
    }

    const role =
      directString(message, 'role') ??
      directString(event, 'role') ??
      'assistant';
    const fullContent = Object.hasOwn(message, 'content')
      ? directValue(message, 'content')
      : Object.hasOwn(event, 'content')
        ? directValue(event, 'content')
        : undefined;
    let rawContent: unknown = this.activeMessage?.content ?? null;
    if (phase === 'started' || phase === 'finished' || role !== 'assistant') {
      // message_end is authoritative; user steering updates also carry their
      // complete message rather than an AssistantMessageEvent delta.
      if (fullContent !== undefined) rawContent = fullContent;
    } else if (assistantEventValue && typeof assistantEventValue === 'object') {
      // 0.84's event union is intentionally handled case-by-case. In
      // particular, a toolcall_delta is not a visible text delta.
      rawContent = applyAssistantMessageEvent(
        rawContent,
        assistantEventValue as AssistantMessageEvent,
        this.activeMessage?.pendingThinking ?? new Map(),
      );
    }
    const safeContent = jsonSafe(rawContent, MAX_FRAME_BYTES);
    if (this.activeMessage) this.activeMessage.content = safeContent;
    const turnId =
      directIdentifier(event, 'turnId') ?? directIdentifier(message, 'turnId');
    const messageData = eventRecord(directValue(message, 'data'));
    const eventData = eventRecord(directValue(event, 'data'));
    const rawData =
      role === 'custom'
        ? {
            customType:
              directString(message, 'customType') ??
              directString(event, 'customType') ??
              directString(messageData, 'customType') ??
              directString(eventData, 'customType'),
            display:
              typeof directValue(message, 'display') === 'boolean'
                ? directValue(message, 'display')
                : typeof directValue(event, 'display') === 'boolean'
                  ? directValue(event, 'display')
                  : typeof directValue(messageData, 'display') === 'boolean'
                    ? directValue(messageData, 'display')
                    : directValue(eventData, 'display'),
            details:
              directValue(message, 'details') ??
              directValue(event, 'details') ??
              directValue(messageData, 'details') ??
              directValue(eventData, 'details'),
          }
        : Object.hasOwn(message, 'data')
          ? directValue(message, 'data')
          : directValue(event, 'data');
    const safeData =
      rawData === undefined ? undefined : jsonSafe(rawData, MAX_FRAME_BYTES);
    const payload: NormalizedMessagePayload = {
      messageId,
      role,
      content: safeContent,
      phase,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(turnId !== undefined ? { turnId: String(turnId) } : {}),
      ...(Array.isArray(directValue(message, 'toolCallIds'))
        ? {
            toolCallIds: (directValue(message, 'toolCallIds') as unknown[])
              .filter((item): item is string => typeof item === 'string')
              .slice(0, 128),
          }
        : {}),
      ...(safeData === undefined ? {} : { data: safeData }),
    };
    if (phase === 'finished') {
      this.activeMessage = undefined;
      this.partialToolCalls.clear();
    }
    return payload;
  }

  /** Normalize one native tool-call stream event without exposing cumulative args. */
  normalizeToolCall(value: unknown): NormalizedToolPayload[] {
    const event = eventRecord(value);
    const contentIndexValue = directValue(event, 'contentIndex');
    const contentIndex =
      typeof contentIndexValue === 'number' &&
      Number.isInteger(contentIndexValue)
        ? contentIndexValue
        : undefined;
    const partial = eventRecord(directValue(event, 'partial'));
    const partialContent = directValue(partial, 'content');
    const partialTool =
      contentIndex === undefined
        ? undefined
        : eventRecord(textBlockAt(partialContent, contentIndex));
    const finalTool = eventRecord(directValue(event, 'toolCall'));
    const previous =
      contentIndex === undefined
        ? undefined
        : this.partialToolCalls.get(contentIndex);
    const toolCallId =
      directString(event, 'toolCallId') ??
      directString(event, 'id') ??
      directString(finalTool, 'toolCallId') ??
      directString(finalTool, 'id') ??
      directString(partialTool ?? {}, 'toolCallId') ??
      directString(partialTool ?? {}, 'id') ??
      previous?.toolCallId;
    const name =
      directString(event, 'toolName') ??
      directString(finalTool, 'toolName') ??
      directString(finalTool, 'name') ??
      directString(partialTool ?? {}, 'toolName') ??
      directString(partialTool ?? {}, 'name') ??
      previous?.name;
    if (!toolCallId || !name || contentIndex === undefined) return [];
    const state = previous ?? {
      toolCallId,
      name,
      pendingDelta: '',
      chars: 0,
      lines: 0,
      escapePending: false,
    };
    state.toolCallId = toolCallId;
    state.name = name;
    const lineTracked = /(?:^|[.:/])(write|edit)$/iu.test(name);
    const rawDelta = directValue(event, 'delta');
    const delta = typeof rawDelta === 'string' ? rawDelta : '';
    if (delta.length > 0) {
      state.pendingDelta += delta;
      state.chars = Math.min(
        MAX_TOOL_ARGUMENT_CHARS,
        state.chars + delta.length,
      );
      if (lineTracked)
        for (const character of delta) {
          if (state.escapePending) {
            if (character === 'n')
              state.lines = Math.min(MAX_TOOL_ARGUMENT_CHARS, state.lines + 1);
            state.escapePending = false;
          } else if (character === '\\') state.escapePending = true;
        }
      this.partialToolCalls.set(contentIndex, state);
    }
    const shouldFlush =
      event.type === 'toolcall_end' ||
      state.pendingDelta.length >= MAX_TOOL_ARGUMENT_DELTA;
    const payloads: NormalizedToolPayload[] = [];
    if (shouldFlush) {
      while (state.pendingDelta.length >= MAX_TOOL_ARGUMENT_DELTA) {
        const chunk = state.pendingDelta.slice(0, MAX_TOOL_ARGUMENT_DELTA);
        state.pendingDelta = state.pendingDelta.slice(MAX_TOOL_ARGUMENT_DELTA);
        payloads.push({
          toolCallId,
          name,
          phase: 'updated',
          argumentDelta: chunk,
          ...(state.chars > 0 ? { argumentChars: state.chars } : {}),
          ...(lineTracked && state.chars > 0
            ? { argumentLines: state.lines + 1 }
            : {}),
          status: 'pending',
        });
      }
      if (event.type === 'toolcall_end' && state.pendingDelta.length > 0) {
        payloads.push({
          toolCallId,
          name,
          phase: 'updated',
          argumentDelta: state.pendingDelta,
          ...(state.chars > 0 ? { argumentChars: state.chars } : {}),
          ...(lineTracked && state.chars > 0
            ? { argumentLines: state.lines + 1 }
            : {}),
          status: 'pending',
        });
        state.pendingDelta = '';
      }
    }
    if (event.type === 'toolcall_end')
      this.partialToolCalls.delete(contentIndex);
    else this.partialToolCalls.set(contentIndex, state);
    if (event.type === 'toolcall_start')
      return [{ toolCallId, name, phase: 'started', status: 'pending' }];
    return payloads;
  }

  normalizeTool(
    phase: 'started' | 'updated' | 'finished',
    value: unknown,
  ): NormalizedToolPayload {
    const event = eventRecord(value);
    const suppliedId = directValue(event, 'toolCallId');
    const toolCallId =
      typeof suppliedId === 'string' && suppliedId.length > 0
        ? suppliedId
        : `${this.runtimeEpoch}:tool:${++this.identitySequence}`;
    const suppliedName = directString(event, 'toolName');
    const name = suppliedName ?? this.activeToolNames.get(toolCallId) ?? 'tool';
    if (phase !== 'finished') this.activeToolNames.set(toolCallId, name);
    else this.activeToolNames.delete(toolCallId);
    const suppliedStatus = directString(event, 'status');
    const timestamp = directIdentifier(event, 'timestamp');
    const status =
      suppliedStatus === 'pending' ||
      suppliedStatus === 'running' ||
      suppliedStatus === 'completed' ||
      suppliedStatus === 'success' ||
      suppliedStatus === 'error' ||
      suppliedStatus === 'failed'
        ? suppliedStatus
        : phase === 'finished'
          ? directValue(event, 'isError') === true
            ? 'error'
            : 'completed'
          : 'running';
    const payload: NormalizedToolPayload = {
      toolCallId,
      name,
      phase,
      ...(directValue(event, 'args') !== undefined
        ? { arguments: jsonSafe(directValue(event, 'args'), MAX_FRAME_BYTES) }
        : {}),
      ...(directValue(event, 'result') !== undefined
        ? { result: jsonSafe(directValue(event, 'result'), MAX_FRAME_BYTES) }
        : {}),
      ...(typeof directValue(event, 'isError') === 'boolean'
        ? { isError: directValue(event, 'isError') as boolean }
        : {}),
      status,
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(directIdentifier(event, 'turnId') !== undefined
        ? { turnId: String(directIdentifier(event, 'turnId')) }
        : {}),
    };
    return payload;
  }
}
