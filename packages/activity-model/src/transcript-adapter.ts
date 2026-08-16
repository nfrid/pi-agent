import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  type ActivityGroup,
  groupTranscript,
  type TranscriptEntry,
} from './grouping.js';
import { headersOf, isNarration } from './title.js';

/** A small raw JSONL shape accepted by the shared transcript boundary adapter. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return typeof value?.[key] === 'string' ? value[key] : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('');
  const part = record(value);
  if (!part) return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content !== 'undefined') return contentText(part.content);
  return '';
}

function messageContent(raw: Record<string, unknown>): unknown {
  const message = record(raw.message);
  return message?.content ?? raw.content;
}

function messageRole(raw: Record<string, unknown>): string | undefined {
  const message = record(raw.message);
  return stringField(message, 'role') ?? stringField(raw, 'role');
}

function toolCallParts(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const value = record(part);
    return value?.type === 'toolCall' || value?.type === 'tool_call'
      ? [value]
      : [];
  });
}

function preambleTitle(text: string): string {
  return (
    text
      .split('\n')[0]
      ?.trim()
      .replace(/[.…:]+$/u, '') || text
  );
}

function assistantEntry(raw: Record<string, unknown>): TranscriptEntry {
  const content = messageContent(raw);
  const parts = Array.isArray(content) ? content : [];
  const text = contentText(content).trim();
  const assistant = {
    role: 'assistant',
    content: parts,
  } as unknown as AssistantMessage;
  const textHeaders = headersOf(assistant, 'text');
  const thinkingHeaders = headersOf(assistant, 'thinking');
  const visibleText = text && !isNarration(text) ? text : undefined;
  const message = record(raw.message);
  const hasTools =
    toolCallParts(content).length > 0 ||
    (Array.isArray(message?.toolCallIds) && message.toolCallIds.length > 0) ||
    (Array.isArray(message?.toolCalls) && message.toolCalls.length > 0);
  const preamble =
    visibleText && hasTools ? preambleTitle(visibleText) : undefined;
  const narratedTitle = (
    textHeaders.length > 0 ? textHeaders : thinkingHeaders
  ).at(-1);
  const streaming = raw.__dashboardStreaming === true || raw.streaming === true;
  return {
    kind: 'assistant',
    speaks: streaming ? false : Boolean(visibleText),
    ...(streaming ? { streaming: true } : {}),
    ...(textHeaders.length > 0
      ? { narration: 'announced' as const }
      : thinkingHeaders.length > 0
        ? { narration: 'thought' as const }
        : {}),
    ...(preamble
      ? { title: preamble, titleKind: 'preamble' as const }
      : narratedTitle
        ? { title: narratedTitle, titleKind: 'narration' as const }
        : {}),
  };
}

type RawToolStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'success'
  | 'error'
  | undefined;

function toolEntry(
  name: string | undefined,
  args: unknown,
  status: RawToolStatus,
): TranscriptEntry {
  return {
    kind: 'tool',
    name: name ?? 'tool',
    args,
    ...(status === undefined ? {} : { status }),
    ...(status === 'error' ? { isError: true } : {}),
  };
}

/**
 * Convert one persisted Pi entry to the exact semantic entry used for
 * activity grouping. Presentation adapters may omit the raw event, but they
 * must use this value for their boundary fields.
 */
export function activityEntryFromRaw(raw: unknown): TranscriptEntry {
  const value = record(raw);
  if (!value) return { kind: 'other' };

  const type = stringField(value, 'type');
  const message = record(value.message);
  const role = messageRole(value);
  if (type === 'message' || message !== undefined || role !== undefined) {
    if (role === 'assistant') return assistantEntry(value);
    if (role === 'toolResult' || role === 'tool_result' || role === 'tool') {
      return toolEntry(
        stringField(message, 'toolName') ??
          stringField(value, 'toolName') ??
          stringField(value, 'name'),
        message?.arguments ?? message?.args ?? value.arguments ?? value.args,
        message?.isError === true || value.isError === true
          ? 'error'
          : 'complete',
      );
    }
    // User messages, and provider messages unknown to the model, terminate an
    // activity just as the web transcript does.
    return { kind: 'other' };
  }

  if (type === 'tool') {
    const tool = record(value.tool) ?? value;
    return toolEntry(
      stringField(tool, 'name') ?? stringField(tool, 'toolName'),
      tool.arguments ?? tool.args,
      tool.isError === true || tool.status === 'error'
        ? 'error'
        : (tool.status as RawToolStatus),
    );
  }

  // Session metadata and extension persistence are transparent to an active
  // group. The web projection may hide them, but keeping an explicit semantic
  // continuation here preserves the same physical boundaries on the server.
  if (
    type === 'custom' ||
    type === 'custom_message' ||
    type === 'compaction' ||
    type === 'branch_summary' ||
    type === 'model_change' ||
    type === 'thinking_level_change' ||
    type === 'session_info' ||
    type === 'label'
  )
    return { kind: 'other', continuesGroup: true };
  return { kind: 'other' };
}

export function activityEntriesFromRaw(
  entries: readonly unknown[],
): TranscriptEntry[] {
  return entries.map(activityEntryFromRaw);
}

/** Return the group owning an entry index, if it is part of an activity. */
export function owningActivityGroup(
  groups: readonly ActivityGroup[],
  index: number,
): ActivityGroup | undefined {
  return groups.find((group) => index >= group.start && index <= group.end);
}

/** Derive the owning boundary directly from the canonical grouping function. */
export function owningActivityBoundary(
  entries: readonly TranscriptEntry[],
  index: number,
): ActivityGroup | undefined {
  return owningActivityGroup(groupTranscript(entries), index);
}

// Descriptive aliases make the boundary contract easy to discover without
// introducing renderer-specific grouping helpers.
export const activityGroupBoundary = owningActivityBoundary;
export const groupOwningBoundary = owningActivityBoundary;
/** Compatibility spellings for consumers that describe this as adaptation. */
export const adaptRawTranscriptEntry = activityEntryFromRaw;
export const transcriptEntryFromRaw = activityEntryFromRaw;
