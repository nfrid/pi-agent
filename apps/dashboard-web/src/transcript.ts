import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  type TranscriptEntry as ActivityTranscriptEntry,
  describeTools,
  headersOf,
  isNarration,
} from '@pi-dashboard/activity-model';
import type { DashboardEvent } from './dashboard-transport';

export interface TranscriptModelItem {
  entry: ActivityTranscriptEntry;
  raw: unknown;
  text?: string;
  role?: 'user' | 'assistant';
}

function directStableId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['id', 'messageId', 'responseId', 'toolCallId', 'callId']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  return undefined;
}

function containsStableId(value: unknown, id: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (directStableId(value) === id) return true;
  return Array.isArray(value)
    ? value.some((item) => containsStableId(item, id))
    : Object.values(value as Record<string, unknown>).some((item) =>
        containsStableId(item, id),
      );
}

function stableId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const direct = directStableId(value);
  if (direct) return direct;
  return Array.isArray(value)
    ? value.map(stableId).find((id): id is string => Boolean(id))
    : Object.values(value as Record<string, unknown>)
        .map(stableId)
        .find((id): id is string => Boolean(id));
}

/** Replace only the object at the matching path; arrays are never mistaken for IDs. */
function replaceStable(
  value: unknown,
  id: string,
  replacement: unknown,
): unknown {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value) && directStableId(value) === id) return replacement;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const replaced = replaceStable(item, id, replacement);
      changed ||= replaced !== item;
      return replaced;
    });
    return changed ? next : value;
  }
  let changed = false;
  const next: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const replaced = replaceStable(item, id, replacement);
    changed ||= replaced !== item;
    next[key] = replaced;
  }
  return changed ? next : value;
}

function messageIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const message =
    record.type === 'message' &&
    record.message &&
    typeof record.message === 'object'
      ? (record.message as Record<string, unknown>)
      : record;
  if (typeof message.role !== 'string') return undefined;
  if (
    typeof message.timestamp === 'number' ||
    typeof message.timestamp === 'string'
  )
    return `${message.role}:${message.timestamp}`;
  return undefined;
}

/** Merge a live bridge item by its Pi-stable id, never by array position. */
export function reconcileLiveEvent(
  entries: readonly unknown[],
  event: DashboardEvent['event'],
  sessionId: string,
): unknown[] {
  if (!event?.sessionId || event.sessionId !== sessionId) return [...entries];
  const envelope = event.message ?? event.tool;
  const payload =
    envelope && typeof envelope === 'object'
      ? ((envelope as Record<string, unknown>).message ??
        (envelope as Record<string, unknown>).tool ??
        envelope)
      : envelope;
  const id = stableId(envelope) ?? stableId(payload);
  if (!payload) return [...entries];
  const isMessage = event.type?.startsWith('message.');
  const tool = payload as Record<string, unknown>;
  const nestedReplacement = isMessage
    ? { type: 'message', message: payload }
    : {
        ...tool,
        type: 'toolCall',
        name: tool.toolName ?? tool.name ?? 'tool',
        arguments: tool.arguments ?? tool.args,
      };
  const toolWrapper = {
    type: 'tool',
    tool: { ...tool, name: tool.toolName ?? tool.name },
  };
  const found = id
    ? entries.some((entry) => containsStableId(entry, id))
    : false;
  if (found && id)
    return entries.map((entry) => {
      if (
        !isMessage &&
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).type === 'tool' &&
        containsStableId(entry, id)
      )
        return toolWrapper;
      // A message envelope owns its payload, while a nested tool call owns only
      // its content item. Passing the payload here preserves both outer shapes.
      return replaceStable(entry, id, isMessage ? payload : nestedReplacement);
    });
  const identity = isMessage ? messageIdentity(payload) : undefined;
  if (identity) {
    let index = -1;
    for (
      let entryIndex = entries.length - 1;
      entryIndex >= 0;
      entryIndex -= 1
    ) {
      if (messageIdentity(entries[entryIndex]) === identity) {
        index = entryIndex;
        break;
      }
    }
    if (index >= 0)
      return entries.map((entry, entryIndex) =>
        entryIndex === index ? nestedReplacement : entry,
      );
  }
  if (isMessage && (payload as Record<string, unknown>).role === 'assistant') {
    let index = -1;
    for (
      let entryIndex = entries.length - 1;
      entryIndex >= 0;
      entryIndex -= 1
    ) {
      const entry = entries[entryIndex];
      if (
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).type === 'message' &&
        (
          (entry as Record<string, unknown>).message as
            | Record<string, unknown>
            | undefined
        )?.role === 'assistant'
      ) {
        index = entryIndex;
        break;
      }
    }
    if (index >= 0)
      return entries.map((entry, entryIndex) =>
        entryIndex === index ? nestedReplacement : entry,
      );
  }
  return [...entries, isMessage ? nestedReplacement : toolWrapper];
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map(contentText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  const part = value as Record<string, unknown>;
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content !== 'undefined') return contentText(part.content);
  return '';
}

function messageText(message: Record<string, unknown>): string {
  return contentText(message.content ?? message.text).trim();
}

function toolRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (record.type === 'tool' && record.tool && typeof record.tool === 'object')
    return record.tool as Record<string, unknown>;
  if (
    record.type === 'toolCall' ||
    record.type === 'tool_call' ||
    typeof record.toolName === 'string'
  )
    return record;
  return undefined;
}

export function toTranscriptEntries(
  rawEntries: readonly unknown[],
): TranscriptModelItem[] {
  const toolResults = new Map<string, Record<string, unknown>>();
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const message = entry.message as Record<string, unknown> | undefined;
    if (
      entry.type === 'message' &&
      message?.role === 'toolResult' &&
      typeof message.toolCallId === 'string'
    )
      toolResults.set(message.toolCallId, message);
  }
  const result: TranscriptModelItem[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') {
      result.push({ entry: { kind: 'other' }, raw });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const tool = entry.type === 'tool' ? toolRecord(raw) : undefined;
    if (tool) {
      result.push({
        entry: {
          kind: 'tool',
          name:
            typeof tool.name === 'string'
              ? tool.name
              : typeof tool.toolName === 'string'
                ? tool.toolName
                : 'tool',
          args: tool.arguments ?? tool.args,
        },
        raw,
      });
      continue;
    }
    if (
      entry.type !== 'message' ||
      !entry.message ||
      typeof entry.message !== 'object'
    ) {
      result.push({ entry: { kind: 'other' }, raw });
      continue;
    }
    const message = entry.message as Record<string, unknown>;
    if (message.role === 'toolResult') continue;
    const role =
      message.role === 'user'
        ? 'user'
        : message.role === 'assistant'
          ? 'assistant'
          : undefined;
    const text = messageText(message);
    if (role === 'assistant') {
      const assistant = {
        ...message,
        content: Array.isArray(message.content) ? message.content : [],
      } as unknown as AssistantMessage;
      const textHeaders = headersOf(assistant, 'text');
      const thinkingHeaders = headersOf(assistant, 'thinking');
      const narration =
        textHeaders.length > 0
          ? 'announced'
          : thinkingHeaders.length > 0
            ? 'thought'
            : undefined;
      const visibleText = text && !isNarration(text) ? text : undefined;
      const content = Array.isArray(message.content) ? message.content : [];
      const tools: TranscriptModelItem[] = [];
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const part = item as Record<string, unknown>;
        if (part.type === 'toolCall' || part.type === 'tool_call') {
          const callId =
            typeof part.id === 'string'
              ? part.id
              : typeof part.toolCallId === 'string'
                ? part.toolCallId
                : undefined;
          const outcome = callId ? toolResults.get(callId) : undefined;
          tools.push({
            entry: {
              kind: 'tool',
              name: typeof part.name === 'string' ? part.name : 'tool',
              args: part.arguments ?? part.args,
            },
            raw: outcome
              ? { ...part, result: outcome.content, isError: outcome.isError }
              : part,
          });
        }
      }
      result.push(
        {
          entry: { kind: 'assistant', speaks: Boolean(visibleText), narration },
          raw,
          text: visibleText,
          role,
        },
        ...tools,
      );
    } else result.push({ entry: { kind: 'other' }, raw, text, role });
  }
  return result;
}

export function toolRecordForTranscript(
  raw: unknown,
): Record<string, unknown> | undefined {
  return toolRecord(raw);
}
export function toolOutcome(raw: unknown): 'success' | 'pending' | 'error' {
  const tool = toolRecord(raw);
  if (!tool) return 'pending';
  if (
    tool.error ||
    tool.isError === true ||
    tool.status === 'error' ||
    tool.status === 'failed'
  )
    return 'error';
  if (
    typeof tool.result !== 'undefined' ||
    tool.status === 'completed' ||
    tool.status === 'success'
  )
    return 'success';
  return 'pending';
}
export function toolSummary(tool: Record<string, unknown>): string {
  const args = tool.arguments ?? tool.args;
  if (!args || typeof args !== 'object') return 'activity';
  const values = Object.values(args as Record<string, unknown>).filter(
    (value) => typeof value === 'string',
  );
  return values[0] ? String(values[0]).slice(0, 100) : 'activity';
}
export { describeTools, headersOf, isNarration };
