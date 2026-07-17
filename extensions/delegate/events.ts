import type { Message } from '@earendil-works/pi-ai';
import type { DelegatedRun } from './types';

const MAX_ACTIVITY_COUNT = 20;
const MAX_MESSAGE_COUNT = 100;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 1000;

type ThinkingGroup = {
  id: string;
  text: string;
  titles: string[];
  activityIds: string[];
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
  },
) {
  const existingIndex = activity.id
    ? run.activities.findIndex((existing) => existing.id === activity.id)
    : -1;
  if (existingIndex >= 0) run.activities[existingIndex] = activity;
  else run.activities.push(activity);
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
    const latest = findActivity(run, previous.activityIds.at(-1));
    if (latest) latest.status = 'completed';
  }
  const id = `${key}:group:${state.nextGroupId++}`;
  const group = { id, text: '', titles: [], activityIds: [`${id}:0`] };
  state.active.set(key, group);
  upsertActivity(run, {
    id: group.activityIds[0],
    type: 'thinking',
    label: 'thinking',
    status: 'running',
  });
  return group;
}

function updateThinkingGroup(
  run: DelegatedRun,
  event: Record<string, unknown>,
  text: string,
): ThinkingGroup {
  const state = getThinkingState(run);
  const key = thinkingKey(event);
  const group = state.active.get(key) ?? startThinkingGroup(run, event);
  group.text = `${group.text}${text}`.slice(0, MAX_PREVIEW_CHARS);
  upsertActivity(run, {
    id: group.activityIds[0],
    type: 'thinking',
    label: 'thinking',
    status: 'running',
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
  run.usage.computeUnits += run.routing?.computeUnitsPerTurn ?? 1;
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
    case 'tool_execution_start':
      upsertActivity(run, {
        id: eventId(event, 'tool'),
        type: 'tool',
        label: toolLabel(String(event.toolName || 'tool'), event.args),
        status: 'running',
      });
      return true;
    case 'tool_execution_update':
      upsertActivity(run, {
        id: eventId(event, 'tool'),
        type: 'tool',
        label: existingToolLabel(run, event),
        status: 'running',
      });
      return true;
    case 'tool_execution_end':
      upsertActivity(run, {
        id: eventId(event, 'tool'),
        type: 'tool',
        label: existingToolLabel(run, event),
        status: event.isError ? 'error' : 'completed',
      });
      return true;
    case 'message_update': {
      const assistantMessageEvent = asRecord(event.assistantMessageEvent);
      if (assistantMessageEvent?.type === 'thinking_start') {
        startThinkingGroup(run, event);
        return true;
      }
      if (assistantMessageEvent?.type === 'thinking_delta') {
        updateThinkingGroup(
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
        if (
          typeof assistantMessageEvent.content === 'string' &&
          !assistantMessageEvent.content.startsWith(group.text)
        )
          group = updateThinkingGroup(
            run,
            event,
            assistantMessageEvent.content,
          );
        const latest = findActivity(run, group.activityIds.at(-1));
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
