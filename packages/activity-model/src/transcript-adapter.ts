import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  type ActivityGroup,
  groupTranscript,
  type TranscriptEntry,
} from './grouping.js';
import { headersOf, isNarration } from './title.js';
import type { ActivitySemanticEntry } from './types.js';

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

/**
 * Convert typed domain semantics into the shared activity entry. Raw JSONL
 * adaptation below is only a compatibility translation into this function.
 */
export function activityEntryFromSemantic(
  input: ActivitySemanticEntry,
): TranscriptEntry {
  if (input.kind === 'assistant') {
    const parts = Array.isArray(input.content) ? input.content : [];
    const text = contentText(input.content).trim();
    const assistant = {
      role: 'assistant',
      content: parts,
    } as unknown as AssistantMessage;
    const textHeaders = headersOf(assistant, 'text');
    const thinkingHeaders = headersOf(assistant, 'thinking');
    const visibleText = text && !isNarration(text) ? text : undefined;
    const hasTools =
      input.associatedToolCallIds.length > 0 ||
      input.hasAssociatedTools === true;
    const preamble =
      visibleText && hasTools ? preambleTitle(visibleText) : undefined;
    const narratedTitle = (
      textHeaders.length > 0 ? textHeaders : thinkingHeaders
    ).at(-1);
    return {
      kind: 'assistant',
      // Live text is ordinary speech until a tool association proves it is a
      // preamble. Once the call arrives, the same entry becomes the group's
      // leader.
      speaks: Boolean(visibleText) && !preamble,
      ...(input.streaming ? { streaming: true } : {}),
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
  if (input.kind === 'tool') {
    return {
      kind: 'tool',
      name: input.name,
      args: input.args,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.isError || input.status === 'error' ? { isError: true } : {}),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.data === undefined ? {} : { data: input.data }),
    };
  }
  return {
    kind: 'other',
    ...(input.continuesGroup === undefined
      ? {}
      : { continuesGroup: input.continuesGroup }),
  };
}

type RawToolStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'success'
  | 'error'
  | undefined;

/**
 * Convert one persisted Pi entry to typed semantic input, then use the same
 * authority as live projections for activity grouping.
 */
export function activityEntryFromRaw(raw: unknown): TranscriptEntry {
  const value = record(raw);
  if (!value) return activityEntryFromSemantic({ kind: 'other' });

  const type = stringField(value, 'type');
  const message = record(value.message);
  const role = messageRole(value);
  if (type === 'message' || message !== undefined || role !== undefined) {
    if (role === 'assistant') {
      const content = messageContent(value);
      const toolCalls = toolCallParts(content);
      const toolCallIds = Array.isArray(message?.toolCallIds)
        ? message.toolCallIds.filter(
            (id): id is string => typeof id === 'string',
          )
        : [];
      return activityEntryFromSemantic({
        kind: 'assistant',
        content,
        associatedToolCallIds: [
          ...toolCallIds,
          ...toolCalls
            .map(
              (part) =>
                stringField(part, 'id') ?? stringField(part, 'toolCallId'),
            )
            .filter((id): id is string => id !== undefined),
        ],
        hasAssociatedTools:
          toolCalls.length > 0 ||
          (Array.isArray(message?.toolCallIds) &&
            message.toolCallIds.length > 0) ||
          (Array.isArray(message?.toolCalls) && message.toolCalls.length > 0),
        streaming:
          value.__dashboardStreaming === true ||
          value.streaming === true ||
          message?.__dashboardStreaming === true ||
          message?.streaming === true,
      });
    }
    if (role === 'toolResult' || role === 'tool_result' || role === 'tool') {
      const isError = message?.isError === true || value.isError === true;
      return activityEntryFromSemantic({
        kind: 'tool',
        name:
          stringField(message, 'toolName') ??
          stringField(value, 'toolName') ??
          stringField(value, 'name') ??
          'tool',
        args:
          message?.arguments ?? message?.args ?? value.arguments ?? value.args,
        status: isError ? 'error' : 'complete',
        result:
          message?.result ?? value.result ?? message?.content ?? value.content,
        data: message?.data ?? value.data,
        isError,
      });
    }
    // User messages, and provider messages unknown to the model, terminate an
    // activity just as the web transcript does.
    return activityEntryFromSemantic({ kind: 'other' });
  }

  if (type === 'tool') {
    const tool = record(value.tool) ?? value;
    return activityEntryFromSemantic({
      kind: 'tool',
      name:
        stringField(tool, 'name') ?? stringField(tool, 'toolName') ?? 'tool',
      args: tool.arguments ?? tool.args,
      status:
        tool.isError === true || tool.status === 'error'
          ? 'error'
          : (tool.status as RawToolStatus),
      result: tool.result,
      data: tool.data,
      isError: tool.isError === true,
    });
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
    return activityEntryFromSemantic({ kind: 'other', continuesGroup: true });
  return activityEntryFromSemantic({ kind: 'other' });
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
