import type { Message } from '@earendil-works/pi-ai';
import {
  captureDelegateResultEvent,
  markStructuredResultRepair,
  redactDelegateResultTerminalProse,
} from './structured-result';
import type { DelegatedRun } from './types';

const MAX_ACTIVITY_COUNT = 96;
const MAX_MESSAGE_COUNT = 100;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_THINKING_TRANSCRIPT_CHARS = 8_000;
const MAX_TOOL_PAYLOAD_CHARS = 6_000;
const MAX_TOOL_PAYLOAD_DEPTH = 4;
const MAX_TOOL_PAYLOAD_NODES = 64;
const MAX_TOOL_PAYLOAD_ITEMS = 16;
const MAX_TOOL_PAYLOAD_KEY_CHARS = 128;

type BoundedToolPayload = { value: unknown; truncated: boolean };

/** Keep final tool input/output structured but small enough for live patches. */
function boundedToolPayload(value: unknown): BoundedToolPayload {
  let remainingChars = MAX_TOOL_PAYLOAD_CHARS;
  let remainingNodes = MAX_TOOL_PAYLOAD_NODES;
  let truncated = false;
  const visit = (current: unknown, depth: number): unknown => {
    if (depth >= MAX_TOOL_PAYLOAD_DEPTH || remainingNodes-- <= 0) {
      truncated = true;
      return '[truncated]';
    }
    if (typeof current === 'string') {
      const limit = Math.max(0, Math.min(1_024, remainingChars));
      const next = current.slice(0, limit);
      remainingChars -= next.length;
      if (next.length !== current.length) truncated = true;
      return next;
    }
    if (
      current === null ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    )
      return current;
    if (Array.isArray(current)) {
      const values = current.slice(0, MAX_TOOL_PAYLOAD_ITEMS);
      if (values.length !== current.length) truncated = true;
      return values.map((item) => visit(item, depth + 1));
    }
    if (current && typeof current === 'object') {
      const output: Record<string, unknown> = Object.create(null);
      const entries = Object.entries(current).slice(0, MAX_TOOL_PAYLOAD_ITEMS);
      if (entries.length !== Object.keys(current).length) truncated = true;
      for (const [key, item] of entries) {
        const boundedKey = key.slice(0, MAX_TOOL_PAYLOAD_KEY_CHARS);
        if (boundedKey !== key) truncated = true;
        output[boundedKey] = visit(item, depth + 1);
      }
      return output;
    }
    truncated = true;
    return String(current).slice(0, 256);
  };
  return { value: visit(value, 0), truncated };
}

type ThinkingGroup = {
  id: string;
  text: string;
  activityId: string;
};

type ThinkingRunState = {
  active: Map<string, ThinkingGroup>;
  nextGroupId: number;
};

const thinkingState = new WeakMap<DelegatedRun, ThinkingRunState>();

function pathValue(value: unknown, fallback = '.'): string {
  return typeof value === 'string' && value
    ? value.replace(/^\/Users\/[^/]+/, '~')
    : fallback;
}

function compactPreview(value: unknown, max = 180): string {
  const raw =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();
  const compact = raw.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function toolLabel(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return name;
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'bash':
      return 'bash';
    case 'read':
      return `read ${pathValue(a.path ?? a.file_path, '...')}`;
    case 'write':
      return `write ${pathValue(a.path ?? a.file_path, '...')}`;
    case 'edit':
      return `edit ${pathValue(a.path ?? a.file_path, '...')}`;
    case 'ls':
      return `ls ${pathValue(a.path)}`;
    case 'find':
      return `find in ${pathValue(a.path)}`;
    case 'grep':
      return `grep in ${pathValue(a.path)}`;
    default:
      return name;
  }
}

function toolInputPreview(name: string, args: unknown): string | undefined {
  // The terminating structured channel may contain the complete artifact-only
  // result. Never put its arguments in a progress activity, even as a
  // non-enumerable preview.
  if (name === 'delegate_result') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  if (name === 'bash') return compactPreview(a.command ?? '');
  if (['read', 'write', 'edit', 'ls', 'find', 'grep'].includes(name))
    return undefined;
  const preview = compactPreview(args);
  return preview && preview !== '{}' ? preview : undefined;
}

function findActivity(
  run: DelegatedRun,
  id: string | undefined,
): DelegatedRun['activities'][number] | undefined {
  return id ? run.activities.find((activity) => activity.id === id) : undefined;
}

function upsertActivity(
  run: DelegatedRun,
  activity: {
    id?: string;
    type: 'thinking' | 'tool';
    label: string;
    status: 'running' | 'completed' | 'error';
    latestText?: string;
    transcriptText?: string;
    toolName?: string;
    toolArguments?: unknown;
    toolResult?: unknown;
    toolArgumentsTruncated?: boolean;
    toolResultTruncated?: boolean;
    startedAt?: number;
  },
) {
  const existingIndex = activity.id
    ? run.activities.findIndex((existing) => existing.id === activity.id)
    : -1;
  const existing =
    existingIndex >= 0 ? run.activities[existingIndex] : undefined;
  const {
    latestText = existing?.latestText,
    transcriptText = existing?.transcriptText,
    toolName = existing?.toolName,
    toolArguments = existing?.toolArguments,
    toolResult = existing?.toolResult,
    toolArgumentsTruncated = existing?.toolArgumentsTruncated,
    toolResultTruncated = existing?.toolResultTruncated,
    startedAt = existing?.startedAt ?? Date.now(),
    ...safeActivity
  } = activity;
  const stored = {
    ...safeActivity,
    startedAt,
  } as DelegatedRun['activities'][number];
  if (latestText)
    Object.defineProperty(stored, 'latestText', {
      value: latestText,
      enumerable: false,
      configurable: true,
    });
  if (transcriptText)
    Object.defineProperty(stored, 'transcriptText', {
      value: transcriptText,
      enumerable: false,
      configurable: true,
    });
  if (toolName)
    Object.defineProperty(stored, 'toolName', {
      value: toolName,
      enumerable: false,
      configurable: true,
    });
  if (toolArguments !== undefined)
    Object.defineProperty(stored, 'toolArguments', {
      value: toolArguments,
      enumerable: false,
      configurable: true,
    });
  if (toolResult !== undefined)
    Object.defineProperty(stored, 'toolResult', {
      value: toolResult,
      enumerable: false,
      configurable: true,
    });
  if (toolArgumentsTruncated)
    Object.defineProperty(stored, 'toolArgumentsTruncated', {
      value: true,
      enumerable: false,
      configurable: true,
    });
  if (toolResultTruncated)
    Object.defineProperty(stored, 'toolResultTruncated', {
      value: true,
      enumerable: false,
      configurable: true,
    });
  if (existingIndex >= 0) run.activities[existingIndex] = stored;
  else run.activities.push(stored);
  while (run.activities.length > MAX_ACTIVITY_COUNT) run.activities.shift();
}

function eventId(
  event: Record<string, unknown>,
  prefix: string,
): string | undefined {
  if (typeof event.toolCallId === 'string')
    return `${prefix}:${event.toolCallId}`;
  const assistantMessageEvent = asRecord(event.assistantMessageEvent);
  const contentIndex = assistantMessageEvent?.contentIndex;
  if (typeof contentIndex === 'number') return `${prefix}:${contentIndex}`;
  return undefined;
}

function existingToolLabel(
  run: DelegatedRun,
  event: Record<string, unknown>,
): string {
  const name = String(event.toolName || 'tool');
  if (event.args && typeof event.args === 'object')
    return toolLabel(name, event.args);
  return findActivity(run, eventId(event, 'tool'))?.label ?? name;
}

function getThinkingState(run: DelegatedRun): ThinkingRunState {
  let state = thinkingState.get(run);
  if (!state) {
    state = { active: new Map(), nextGroupId: 0 };
    thinkingState.set(run, state);
  }
  return state;
}

function thinkingKey(event: Record<string, unknown>): string {
  return eventId(event, 'thinking') ?? 'thinking';
}

function startThinkingGroup(
  run: DelegatedRun,
  event: Record<string, unknown>,
): ThinkingGroup {
  const state = getThinkingState(run);
  const key = thinkingKey(event);
  const previous = state.active.get(key);
  if (previous) {
    const latest = findActivity(run, previous.activityId);
    if (latest) latest.status = 'completed';
  }
  const id = `${key}:group:${state.nextGroupId++}`;
  const group = { id, text: '', activityId: `${id}:0` };
  state.active.set(key, group);
  upsertActivity(run, {
    id: group.activityId,
    type: 'thinking',
    label: 'thinking',
    status: 'running',
  });
  return group;
}

/**
 * Thinking streams as a run of paragraphs, and only the last one is still being
 * written. Previewing the whole accumulation runs finished paragraphs together
 * into one wall of text that never advances, so the preview is the newest
 * paragraph on its own.
 */
export function latestThinkingParagraph(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  for (let index = paragraphs.length - 1; index >= 0; index--) {
    const paragraph = paragraphs[index].trim();
    if (paragraph) return paragraph;
  }
  return text.trim();
}

function writeThinkingGroup(
  run: DelegatedRun,
  event: Record<string, unknown>,
  text: string,
  mode: 'append' | 'replace' = 'append',
): ThinkingGroup {
  const state = getThinkingState(run);
  const key = thinkingKey(event);
  const group = state.active.get(key) ?? startThinkingGroup(run, event);
  // Keep a bounded complete block for the dashboard transcript. When it grows
  // beyond the live budget, retain the newest text rather than freezing on the
  // opening paragraph.
  group.text = (mode === 'replace' ? text : `${group.text}${text}`).slice(
    -MAX_THINKING_TRANSCRIPT_CHARS,
  );
  upsertActivity(run, {
    id: group.activityId,
    type: 'thinking',
    label: 'thinking',
    status: 'running',
    latestText: latestThinkingParagraph(group.text),
    transcriptText: group.text,
  });
  return group;
}

function messageBytes(messages: Message[]): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

function addMessage(run: DelegatedRun, message: Message) {
  const sanitized =
    message.role === 'assistant'
      ? {
          ...message,
          content: message.content.filter((part) => part.type === 'text'),
        }
      : message;
  run.messages.push(sanitized as Message);
  redactDelegateResultTerminalProse(run);
  while (
    run.messages.length > 1 &&
    (run.messages.length > MAX_MESSAGE_COUNT ||
      messageBytes(run.messages) > MAX_MESSAGE_BYTES)
  )
    run.messages.shift();
  updateMessageMetadata(run, message);
}

function updateMessageMetadata(run: DelegatedRun, message: Message) {
  if (message.role !== 'assistant') return;
  const usage = message.usage;
  if (usage) {
    run.usage.input += usage.input || 0;
    run.usage.output += usage.output || 0;
    run.usage.cacheRead += usage.cacheRead || 0;
    run.usage.cacheWrite += usage.cacheWrite || 0;
    run.usage.contextTokens = usage.totalTokens || run.usage.contextTokens;
    run.usage.cost += usage.cost?.total || 0;
  }
  if (message.model) run.model = message.model;
  run.usage.turns++;
  if (message.stopReason) run.stopReason = message.stopReason;
  if (message.errorMessage) run.errorMessage = message.errorMessage;
}

function assistantFingerprint(message: Message): string {
  if (message.role !== 'assistant') return '';
  return JSON.stringify({
    timestamp: message.timestamp,
    model: message.model,
    stopReason: message.stopReason,
    usage: message.usage,
    text: message.content
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : '')),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export function processJsonLine(line: string, run: DelegatedRun): boolean {
  if (!line.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  const event = asRecord(parsed);
  if (!event) return false;

  switch (event.type) {
    case 'delegate_structured_repair':
      markStructuredResultRepair(run);
      return true;
    case 'message_end':
      if (
        event.message &&
        (event.message as { role?: unknown }).role === 'assistant'
      ) {
        addMessage(run, event.message as Message);
        return true;
      }
      return false;
    case 'agent_end': {
      // message_end is authoritative. Reconcile any missing assistant event by
      // stable response metadata without duplicating events already processed.
      if (Array.isArray(event.messages)) {
        const existing = new Set(
          run.messages
            .filter((message) => message.role === 'assistant')
            .map(assistantFingerprint),
        );
        const missing = (event.messages as Message[]).filter(
          (message) =>
            message.role === 'assistant' &&
            !existing.has(assistantFingerprint(message)),
        );
        for (const message of missing) addMessage(run, message);
        return missing.length > 0;
      }
      return false;
    }
    case 'tool_execution_start': {
      const name = String(event.toolName || 'tool');
      const input =
        name === 'delegate_result' || event.args === undefined
          ? undefined
          : boundedToolPayload(event.args);
      upsertActivity(run, {
        id: eventId(event, 'tool'),
        type: 'tool',
        label: toolLabel(name, event.args),
        status: 'running',
        toolName: name,
        ...(input === undefined ? {} : { toolArguments: input.value }),
        ...(input?.truncated ? { toolArgumentsTruncated: true } : {}),
        latestText: toolInputPreview(name, event.args),
      });
      return true;
    }
    case 'tool_execution_update':
      upsertActivity(run, {
        id: eventId(event, 'tool'),
        type: 'tool',
        label: existingToolLabel(run, event),
        status: 'running',
      });
      return true;
    case 'tool_execution_end': {
      const name = String(event.toolName || 'tool');
      if (name === 'delegate_result')
        captureDelegateResultEvent(run, event.result, event.isError === true);
      const output =
        name === 'delegate_result' || event.result === undefined
          ? undefined
          : boundedToolPayload(event.result);
      const input =
        name === 'delegate_result' || event.args === undefined
          ? undefined
          : boundedToolPayload(event.args);
      upsertActivity(run, {
        id: eventId(event, 'tool'),
        type: 'tool',
        label: existingToolLabel(run, event),
        status: event.isError ? 'error' : 'completed',
        toolName: name,
        ...(input === undefined ? {} : { toolArguments: input.value }),
        ...(input?.truncated ? { toolArgumentsTruncated: true } : {}),
        ...(output === undefined ? {} : { toolResult: output.value }),
        ...(output?.truncated ? { toolResultTruncated: true } : {}),
      });
      return true;
    }
    case 'delegate_control_ack': {
      if (event.controlKind !== 'checkpoint') return false;
      const requested = run.checkpoint;
      if (!requested) return false;
      run.checkpoint = {
        ...requested,
        state: 'acknowledged',
        acknowledgedAt:
          typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      };
      return true;
    }
    case 'message_update': {
      const assistantMessageEvent = asRecord(event.assistantMessageEvent);
      if (assistantMessageEvent?.type === 'thinking_start') {
        startThinkingGroup(run, event);
        return true;
      }
      if (assistantMessageEvent?.type === 'thinking_delta') {
        writeThinkingGroup(
          run,
          event,
          typeof assistantMessageEvent.delta === 'string'
            ? assistantMessageEvent.delta
            : '',
        );
        return true;
      }
      if (assistantMessageEvent?.type === 'thinking_end') {
        const state = getThinkingState(run);
        const key = thinkingKey(event);
        let group = state.active.get(key);
        if (!group) group = startThinkingGroup(run, event);
        // The group only retains the tail of the block, so a complete delta
        // stream ends with exactly what it accumulated; anything else means
        // deltas were missed and the final content is authoritative.
        if (
          typeof assistantMessageEvent.content === 'string' &&
          (!group.text || !assistantMessageEvent.content.endsWith(group.text))
        )
          group = writeThinkingGroup(
            run,
            event,
            assistantMessageEvent.content,
            'replace',
          );
        const latest = findActivity(run, group.activityId);
        if (latest) latest.status = 'completed';
        state.active.delete(key);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}
