import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  type TranscriptEntry as ActivityTranscriptEntry,
  describeTools,
  headersOf,
  isNarration,
} from '@pi-dashboard/activity-model';
export interface TranscriptModelItem {
  key: string;
  entry: ActivityTranscriptEntry;
  raw: unknown;
  text?: string;
  role?: 'user' | 'assistant';
  imageCount?: number;
  /** Live assistant text whose final answer/tool-call intent is not known yet. */
  preparing?: boolean;
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

function messageLevelId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['messageId', 'id', 'responseId'])
    if (typeof record[key] === 'string' && record[key]) return record[key];
  return undefined;
}

function messageRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.type === 'message' &&
    record.message &&
    typeof record.message === 'object' &&
    !Array.isArray(record.message)
  )
    return record.message as Record<string, unknown>;
  return typeof record.role === 'string' ? record : undefined;
}

/** Presentation keys use only IDs explicitly present on the selected entry. */
function transcriptEntryKey(value: unknown, index: number): string {
  const message = messageRecord(value);
  if (message) return messageLevelId(message) ?? `entry-${index}`;
  const direct = directStableId(value);
  if (direct) return direct;
  const tool = toolRecord(value);
  return directStableId(tool) ?? `entry-${index}`;
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

function preambleTitle(text: string): string {
  return (
    text
      .split('\n')[0]
      ?.trim()
      .replace(/[.…:]+$/, '') || text
  );
}

function messageImageCount(message: Record<string, unknown>): number {
  return Array.isArray(message.content)
    ? message.content.filter(
        (part) =>
          part &&
          typeof part === 'object' &&
          (part as Record<string, unknown>).type === 'image',
      ).length
    : 0;
}

function toolRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (
    (record.type === 'tool' || record.kind === 'tool') &&
    record.tool &&
    typeof record.tool === 'object'
  )
    return record.tool as Record<string, unknown>;
  if (
    record.type === 'tool' ||
    record.kind === 'tool' ||
    record.type === 'toolCall' ||
    record.type === 'tool_call' ||
    record.role === 'toolResult' ||
    typeof record.toolName === 'string'
  )
    return record;
  const message = messageRecord(raw);
  return message?.role === 'toolResult' ? message : undefined;
}

export function toTranscriptEntries(
  rawEntries: readonly unknown[],
): TranscriptModelItem[] {
  const toolResults = new Map<string, Record<string, unknown>>();
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') continue;
    const message = messageRecord(raw);
    if (
      message?.role === 'toolResult' &&
      typeof message.toolCallId === 'string'
    )
      toolResults.set(message.toolCallId, message);
  }
  const result: TranscriptModelItem[] = [];
  for (const [rawIndex, raw] of rawEntries.entries()) {
    const entryKey = transcriptEntryKey(raw, rawIndex);
    if (!raw || typeof raw !== 'object') {
      result.push({ key: entryKey, entry: { kind: 'other' }, raw });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const tool =
      entry.type === 'tool' || entry.kind === 'tool'
        ? toolRecord(raw)
        : undefined;
    if (tool) {
      result.push({
        key: entryKey,
        entry: {
          kind: 'tool',
          name:
            typeof tool.name === 'string'
              ? tool.name
              : typeof tool.toolName === 'string'
                ? tool.toolName
                : 'tool',
          args: tool.arguments ?? tool.args,
          status: toolOutcome(raw),
          isError: toolOutcome(raw) === 'error',
        },
        raw,
      });
      continue;
    }
    const message = messageRecord(raw);
    if (!message) {
      result.push({ key: entryKey, entry: { kind: 'other' }, raw });
      continue;
    }
    if (message.role === 'toolResult') continue;
    const role =
      message.role === 'user'
        ? 'user'
        : message.role === 'assistant'
          ? 'assistant'
          : undefined;
    const text = messageText(message);
    const imageCount = messageImageCount(message);
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
          const outcomeStatus = outcome ? toolOutcome(outcome) : 'pending';
          tools.push({
            key: `${entryKey}:tool:${callId ?? tools.length}`,
            entry: {
              kind: 'tool',
              name: typeof part.name === 'string' ? part.name : 'tool',
              args: part.arguments ?? part.args,
              status: outcomeStatus,
              ...(outcomeStatus === 'error' ? { isError: true } : {}),
            },
            raw: outcome
              ? { ...part, result: outcome.content, isError: outcome.isError }
              : part,
          });
        }
      }
      const preparing =
        message.__dashboardStreaming === true && tools.length === 0;
      const preamble =
        visibleText && tools.length > 0
          ? preambleTitle(visibleText)
          : undefined;
      const narratedTitle = (
        textHeaders.length > 0 ? textHeaders : thinkingHeaders
      ).at(-1);
      result.push(
        {
          key: entryKey,
          entry: {
            kind: 'assistant',
            speaks: preparing ? false : Boolean(visibleText),
            ...(preparing ? { streaming: true } : {}),
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
          ...(preparing ? { preparing: true } : {}),
        },
        ...tools,
      );
    } else
      result.push({
        key: entryKey,
        entry: { kind: 'other' },
        raw,
        text,
        role,
        ...(imageCount > 0 ? { imageCount } : {}),
      });
  }
  return result;
}

export function toolRecordForTranscript(
  raw: unknown,
): Record<string, unknown> | undefined {
  return toolRecord(raw);
}
export function toolOutcome(
  raw: unknown,
): 'success' | 'pending' | 'running' | 'error' {
  const tool = toolRecord(raw);
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
export function toolSummary(tool: Record<string, unknown>): string {
  const args = tool.arguments ?? tool.args;
  if (!args || typeof args !== 'object') return 'activity';
  const values = Object.values(args as Record<string, unknown>).filter(
    (value) => typeof value === 'string',
  );
  return values[0] ? String(values[0]).slice(0, 100) : 'activity';
}
export { describeTools, headersOf, isNarration };
