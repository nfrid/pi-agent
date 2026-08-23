import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  type TranscriptEntry as ActivityTranscriptEntry,
  activityEntryFromRaw,
  describeTools,
  headersOf,
  isNarration,
  leadingContinuationSpan,
  toolActionSummary,
} from '@pi-dashboard/activity-model';
import {
  hydrateTranscript,
  projectTranscriptForRender,
  type TranscriptDeliveryMode,
  type TranscriptProjection,
  type TranscriptRenderItem,
  type TranscriptRenderToolItem,
  transcriptToolOutcome,
  transcriptToolRecord,
} from '@pi-dashboard/domain';

export interface TranscriptTodoTask {
  id: string;
  text: string;
  status: string;
}

export type TranscriptEvent =
  | {
      kind: 'compaction' | 'branch-summary';
      label: string;
      summary: string;
      tokensBefore?: number;
      details?: unknown;
    }
  | {
      kind: 'todo';
      label: string;
      tasks: readonly TranscriptTodoTask[];
    }
  | {
      kind: 'delegate-result' | 'background-result';
      label: string;
      status: 'success' | 'error';
      content?: string;
      details?: unknown;
    }
  | {
      kind: 'settings';
      label: string;
      model?: string;
      thinkingLevel?: string;
    }
  | {
      kind: 'custom-message' | 'delegate-feedback';
      label: string;
      content?: string;
      details?: unknown;
    };

export interface TranscriptModelItem {
  key: string;
  entry: ActivityTranscriptEntry;
  raw: unknown;
  text?: string;
  thinking?: readonly string[];
  role?: 'user' | 'assistant';
  deliveryMode?: TranscriptDeliveryMode;
  imageCount?: number;
  event?: TranscriptEvent;
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
    ? projectTranscriptForRender(input, { includeSessionEvents: true }).items
    : projectTranscriptForRender(
        hydrateTranscript(input, undefined, { fallbackEntryIds: true }),
        { includeSessionEvents: true },
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

function numberField(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  return typeof value?.[key] === 'number' ? value[key] : undefined;
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
  if (Array.isArray(content))
    return content.map(contentText).filter(Boolean).join('\n\n').trim();
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

function messageThinking(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .flatMap((part) =>
      part &&
      typeof part === 'object' &&
      (part as Record<string, unknown>).type === 'thinking' &&
      typeof (part as Record<string, unknown>).thinking === 'string'
        ? [(part as { thinking: string }).thinking.trim()]
        : [],
    )
    .filter((thinking) => thinking.length > 0);
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

function todoSnapshot(
  raw: Record<string, unknown>,
): TranscriptTodoTask[] | undefined {
  if (raw.type !== 'custom' || raw.customType !== 'lean-todo') return undefined;
  const state = record(record(raw.data)?.state);
  if (!state || !Array.isArray(state.tasks)) return undefined;
  return state.tasks.flatMap((value) => {
    const task = record(value);
    const id = stringField(task, 'id');
    const text = stringField(task, 'text');
    const status = stringField(task, 'status');
    return id && text && status ? [{ id, text, status }] : [];
  });
}

function todoStatusVerb(status: string): string {
  if (status === 'doing') return 'started';
  if (status === 'done') return 'completed';
  if (status === 'blocked') return 'blocked';
  if (status === 'dropped') return 'dropped';
  return 'queued';
}

function todoEvent(
  previous: readonly TranscriptTodoTask[] | undefined,
  tasks: readonly TranscriptTodoTask[],
): Extract<TranscriptEvent, { kind: 'todo' }> | undefined {
  if (!previous && tasks.length === 0) return undefined;
  const prior = new Map((previous ?? []).map((task) => [task.id, task]));
  const next = new Map(tasks.map((task) => [task.id, task]));
  const changes: string[] = [];
  for (const task of tasks) {
    const old = prior.get(task.id);
    if (!old) changes.push(`${task.id} added`);
    else if (old.status !== task.status)
      changes.push(`${task.id} ${todoStatusVerb(task.status)}`);
  }
  for (const task of previous ?? [])
    if (!next.has(task.id)) changes.push(`${task.id} removed`);
  if (changes.length === 0) return undefined;
  const waiting = tasks.filter((task) => task.status === 'todo').length;
  const active = tasks.filter((task) => task.status === 'doing').length;
  const blocked = tasks.filter((task) => task.status === 'blocked').length;
  const tail = [
    active ? `${active} active` : undefined,
    waiting ? `${waiting} waiting` : undefined,
    blocked ? `${blocked} blocked` : undefined,
  ].filter((part): part is string => Boolean(part));
  const visibleChanges = changes.slice(0, 2);
  if (changes.length > visibleChanges.length)
    visibleChanges.push(`+${changes.length - visibleChanges.length} changes`);
  return {
    kind: 'todo',
    label: ['Tasks', ...visibleChanges, ...tail].join(' · '),
    tasks,
  };
}

function delegateControlEvent(raw: Record<string, unknown>):
  | {
      kind: 'delegate-feedback';
      label: string;
      content?: string;
    }
  | undefined {
  if (
    raw.type !== 'custom_message' ||
    stringField(raw, 'customType') !== 'delegate-control'
  )
    return undefined;
  const rawContent = contentText(raw.content).trim();
  const feedbackPrefix = 'Parent feedback (address this at this checkpoint):\n';
  const checkpointPrefix = 'Parent checkpoint request:\n';
  const hasFeedback = rawContent.includes(feedbackPrefix);
  const hasCheckpoint = rawContent.includes(checkpointPrefix);
  if (!hasFeedback && !hasCheckpoint) return undefined;
  const content = rawContent
    .replaceAll(feedbackPrefix, '')
    .replaceAll(checkpointPrefix, '')
    .trim();
  return {
    kind: 'delegate-feedback',
    label:
      hasFeedback && hasCheckpoint
        ? 'Parent guidance'
        : hasCheckpoint
          ? 'Parent checkpoint'
          : 'Parent feedback',
    ...(content ? { content } : {}),
  };
}

function asyncResultEvent(
  raw: Record<string, unknown>,
):
  | Extract<TranscriptEvent, { kind: 'delegate-result' | 'background-result' }>
  | undefined {
  if (raw.type !== 'custom_message' || raw.display !== true) return undefined;
  const customType = stringField(raw, 'customType');
  const content = contentText(raw.content).trim();
  const details = record(raw.details);
  if (customType === 'delegate-job-result') {
    const jobs = Array.isArray(details?.jobs)
      ? details.jobs.flatMap((value) => {
          const job = record(value);
          return job ? [job] : [];
        })
      : [];
    const match = content.match(
      /^# Background delegate job \S+(?: \(([^)]+)\))? (success|error)/u,
    );
    const name = match?.[1] ?? stringField(jobs[0], 'name');
    const status =
      match?.[2] === 'error' || jobs.some((job) => job.state === 'error')
        ? 'error'
        : 'success';
    const subject =
      jobs.length > 1 ? `${jobs.length} delegate jobs` : (name ?? 'Delegate');
    const visibleContent = content;
    return {
      kind: 'delegate-result',
      label: `${status === 'error' ? 'Delegate failed' : 'Delegate finished'} · ${subject}`,
      status,
      ...(visibleContent ? { content: visibleContent } : {}),
      ...(details ? { details } : {}),
    };
  }
  if (customType === 'background-terminal-result') {
    const status =
      details?.status === 'failed' ||
      (typeof details?.exitCode === 'number' && details.exitCode !== 0)
        ? 'error'
        : 'success';
    const title = stringField(details, 'title') ?? 'Background command';
    const duration = numberField(details, 'duration');
    return {
      kind: 'background-result',
      label: `${status === 'error' ? 'Background command failed' : 'Background command finished'} · ${title}${duration === undefined ? '' : ` · ${Math.max(0, Math.round(duration / 1000))}s`}`,
      status,
      ...(content ? { content } : {}),
      ...(details ? { details } : {}),
    };
  }
  return undefined;
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
      ...(item.deliveryMode === undefined
        ? {}
        : { deliveryMode: item.deliveryMode }),
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
      ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
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
  options: { leadingContinuation?: boolean } = {},
): TranscriptModelItem[] {
  const result: TranscriptModelItem[] = [];
  let previousTodo: readonly TranscriptTodoTask[] | undefined;
  let hasConversation = false;
  for (const item of renderItems(input)) {
    if (item.kind === 'other') {
      const raw = record(item.raw);
      if (!raw) {
        result.push({ key: item.key, entry: { kind: 'other' }, raw: item.raw });
        continue;
      }
      const tasks = todoSnapshot(raw);
      if (tasks) {
        const event = todoEvent(previousTodo, tasks);
        previousTodo = tasks;
        if (event)
          result.push({
            key: item.key,
            entry: { kind: 'other', continuesGroup: true },
            raw: item.raw,
            event,
          });
        continue;
      }
      if (raw.type === 'custom') continue;
      if (raw.type === 'compaction' || raw.type === 'branch_summary') {
        const summary = stringField(raw, 'summary');
        if (!summary) continue;
        const isBranch = raw.type === 'branch_summary';
        result.push({
          key: item.key,
          entry: { kind: 'other', continuesGroup: true },
          raw: item.raw,
          event: {
            kind: isBranch ? 'branch-summary' : 'compaction',
            label: isBranch ? 'Branch context summarized' : 'Context compacted',
            summary,
            ...(isBranch
              ? {}
              : numberField(raw, 'tokensBefore') === undefined
                ? {}
                : { tokensBefore: numberField(raw, 'tokensBefore') }),
            ...(raw.details === undefined ? {} : { details: raw.details }),
          },
        });
        continue;
      }
      if (raw.type === 'model_change' || raw.type === 'thinking_level_change') {
        if (!hasConversation) continue;
        const prior = result.at(-1);
        const current =
          prior?.event?.kind === 'settings' ? prior.event : undefined;
        const model =
          raw.type === 'model_change'
            ? [stringField(raw, 'provider'), stringField(raw, 'modelId')]
                .filter(Boolean)
                .join('/')
            : current?.model;
        const thinkingLevel =
          raw.type === 'thinking_level_change'
            ? stringField(raw, 'thinkingLevel')
            : current?.thinkingLevel;
        const label = [
          model ? `Model → ${model}` : undefined,
          thinkingLevel ? `thinking ${thinkingLevel}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
        if (!label) continue;
        const event: Extract<TranscriptEvent, { kind: 'settings' }> = {
          kind: 'settings',
          label,
          ...(model ? { model } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        };
        if (prior && current) prior.event = event;
        else
          result.push({
            key: item.key,
            entry: { kind: 'other', continuesGroup: true },
            raw: item.raw,
            event,
          });
        continue;
      }
      if (raw.type === 'custom_message') {
        const event = delegateControlEvent(raw) ?? asyncResultEvent(raw);
        if (event) {
          result.push({
            key: item.key,
            entry: { kind: 'other', continuesGroup: true },
            raw: item.raw,
            event,
          });
          continue;
        }
        if (raw.display !== true) continue;
        const customType = stringField(raw, 'customType') ?? 'extension';
        const content = contentText(raw.content).trim();
        result.push({
          key: item.key,
          entry: { kind: 'other', continuesGroup: true },
          raw: item.raw,
          event: {
            kind: 'custom-message',
            label: customType.replaceAll('-', ' '),
            ...(content ? { content } : {}),
            ...(raw.details === undefined ? {} : { details: raw.details }),
          },
        });
        continue;
      }
      if (
        raw.type === 'session' ||
        raw.type === 'session_info' ||
        raw.type === 'label'
      )
        continue;
      result.push({ key: item.key, entry: { kind: 'other' }, raw: item.raw });
      continue;
    }
    hasConversation = true;
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
    const thinking = messageThinking(item.content);
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
        ...(item.deliveryMode === undefined
          ? {}
          : { deliveryMode: item.deliveryMode }),
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
    if (
      !visibleText &&
      thinking.length === 0 &&
      imageCount === 0 &&
      !item.preparing
    )
      continue;
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
      ...(thinking.length > 0 ? { thinking } : {}),
      role,
      ...(imageCount > 0 ? { imageCount } : {}),
      ...(item.preparing ? { preparing: true } : {}),
    });
  }
  // Grouping boundaries are owned by activity-model for both persisted raw
  // entries and the domain projection. Keep all presentation fields above,
  // but replace the boundary payload with the canonical raw mapping.
  const mapped = result.map((item) => ({
    ...item,
    entry: activityEntryFromRaw(item.raw),
  }));
  const hidden = leadingContinuationSpan(
    mapped.map((item) => item.entry),
    options.leadingContinuation,
  );
  return hidden
    ? mapped.filter((_, index) => index < hidden.start || index > hidden.end)
    : mapped;
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
