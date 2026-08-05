import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  type TranscriptEntry as ActivityTranscriptEntry,
  describeTools,
  headersOf,
  isNarration,
  toolActionSummary,
} from '@pi-dashboard/activity-model';
import {
  hydrateTranscript,
  projectTranscriptForRender,
  type TranscriptProjection,
  type TranscriptRenderItem,
  type TranscriptRenderToolItem,
  transcriptToolOutcome,
  transcriptToolRecord,
} from '@pi-dashboard/domain';

export interface TranscriptModelItem {
  key: string;
  entry: ActivityTranscriptEntry;
  raw: unknown;
  text?: string;
  role?: 'user' | 'assistant';
  imageCount?: number;
  /** Canonical domain tool semantics used by the inspector presentation. */
  tool?: TranscriptRenderToolItem;
  /** Live assistant text whose final answer/tool-call intent is not known yet. */
  preparing?: boolean;
}

export type TranscriptInput = TranscriptProjection | readonly unknown[];

function isTranscriptProjection(
  value: TranscriptInput,
): value is TranscriptProjection {
  if (Array.isArray(value) || typeof value !== 'object' || value === null)
    return false;
  const candidate = value as TranscriptProjection;
  return (
    Array.isArray(candidate.order) &&
    typeof candidate.items === 'object' &&
    candidate.items !== null
  );
}

function renderItems(input: TranscriptInput): readonly TranscriptRenderItem[] {
  const projected = isTranscriptProjection(input)
    ? projectTranscriptForRender(input).items
    : projectTranscriptForRender(
        hydrateTranscript(input, undefined, { fallbackEntryIds: true }),
      ).items;
  // Historical raw-entry adaptation used a nested React key for an embedded
  // tool call. Keep that presentation key while taking the association itself
  // exclusively from the domain projection.
  const toolKeys = new Map<string, string>();
  for (const item of projected)
    if (item.kind === 'message')
      for (const toolCallId of item.associatedToolCallIds)
        toolKeys.set(toolCallId, `${item.key}:tool:${toolCallId}`);
  return projected.map((item) =>
    item.kind === 'tool'
      ? { ...item, key: toolKeys.get(item.toolCallId) ?? item.key }
      : item,
  );
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

function messageText(content: unknown): string {
  return contentText(content).trim();
}

function preambleTitle(text: string): string {
  return (
    text
      .split('\n')[0]
      ?.trim()
      .replace(/[.…:]+$/, '') || text
  );
}

function messageImageCount(content: unknown): number {
  return Array.isArray(content)
    ? content.filter(
        (part) =>
          part &&
          typeof part === 'object' &&
          (part as Record<string, unknown>).type === 'image',
      ).length
    : 0;
}

function messageRaw(item: Extract<TranscriptRenderItem, { kind: 'message' }>) {
  return {
    type: 'message',
    message: {
      id: item.messageId,
      messageId: item.messageId,
      role: item.role,
      content: item.content,
      ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
      ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
      ...(item.toolCallIds.length === 0
        ? {}
        : { toolCallIds: item.toolCallIds }),
      ...(item.streaming ? { __dashboardStreaming: true } : {}),
    },
  };
}

function toolRaw(item: TranscriptRenderToolItem) {
  return {
    type: 'tool',
    tool: {
      toolCallId: item.toolCallId,
      id: item.toolCallId,
      name: item.name,
      ...(item.arguments === undefined ? {} : { arguments: item.arguments }),
      ...(item.result === undefined ? {} : { result: item.result }),
      ...(item.isError === undefined ? {} : { isError: item.isError }),
      status: item.status,
    },
  };
}

/**
 * Adapt the canonical domain render projection to activity-model entries.
 * Content text and narration remain presentation concerns; identities,
 * pairing, outcomes, and streaming/preparing flags come from the domain.
 */
export function toTranscriptEntries(
  input: TranscriptInput,
): TranscriptModelItem[] {
  const result: TranscriptModelItem[] = [];
  for (const item of renderItems(input)) {
    if (item.kind === 'other') {
      result.push({ key: item.key, entry: { kind: 'other' }, raw: item.raw });
      continue;
    }
    if (item.kind === 'tool') {
      result.push({
        key: item.key,
        entry: {
          kind: 'tool',
          name: item.name,
          args: item.arguments,
          status: item.status,
          ...(item.status === 'error' ? { isError: true } : {}),
        },
        raw: toolRaw(item),
        tool: item,
      });
      continue;
    }
    const text = messageText(item.content);
    const imageCount = messageImageCount(item.content);
    const raw = messageRaw(item);
    const role =
      item.role === 'user'
        ? 'user'
        : item.role === 'assistant'
          ? 'assistant'
          : undefined;
    if (role !== 'assistant') {
      result.push({
        key: item.key,
        entry: { kind: 'other' },
        raw,
        text,
        ...(role === undefined ? {} : { role }),
        ...(imageCount > 0 ? { imageCount } : {}),
      });
      continue;
    }
    const assistant = {
      role: item.role,
      content: Array.isArray(item.content) ? item.content : [],
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
    const hasAssociatedTools = item.associatedToolCallIds.length > 0;
    const preamble =
      visibleText && hasAssociatedTools
        ? preambleTitle(visibleText)
        : undefined;
    const narratedTitle = (
      textHeaders.length > 0 ? textHeaders : thinkingHeaders
    ).at(-1);
    result.push({
      key: item.key,
      entry: {
        kind: 'assistant',
        speaks: item.preparing ? false : Boolean(visibleText),
        ...(item.preparing ? { streaming: true } : {}),
        narration,
        title: preamble ?? narratedTitle,
        ...(preamble
          ? { titleKind: 'preamble' as const }
          : narratedTitle
            ? { titleKind: 'narration' as const }
            : {}),
      },
      raw,
      text: visibleText,
      role,
      ...(imageCount > 0 ? { imageCount } : {}),
      ...(item.preparing ? { preparing: true } : {}),
    });
  }
  return result;
}

/** Compatibility helper retained for consumers with raw tool entries. */
export function toolRecordForTranscript(
  raw: unknown,
): Record<string, unknown> | undefined {
  return transcriptToolRecord(raw);
}

/** Compatibility spelling; lifecycle semantics are owned by dashboard-domain. */
export function toolOutcome(
  raw: unknown,
): 'success' | 'pending' | 'running' | 'error' {
  return transcriptToolOutcome(raw);
}

/** Tool labels are presentation-only and remain available to web consumers. */
export function toolSummary(tool: Record<string, unknown>): string {
  const name =
    typeof tool.name === 'string'
      ? tool.name
      : typeof tool.toolName === 'string'
        ? tool.toolName
        : 'tool';
  return toolActionSummary({
    name,
    args: tool.arguments ?? tool.args,
  });
}

export { describeTools, headersOf, isNarration };
