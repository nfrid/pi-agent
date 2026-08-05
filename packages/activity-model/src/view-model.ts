import {
  type ActivityGroup,
  activityKind,
  groupTranscript,
  type ToolDescriptor,
  type TranscriptEntry,
} from './grouping.js';
import { hasUnresolvedToolFailure } from './outcome.mjs';
import { describeTools } from './title.js';

export type ActivityGroupStatus = 'live' | 'preparing' | 'complete' | 'failed';

export interface ActivityGroupViewModel {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly kind: ReturnType<typeof activityKind>;
  readonly title: string;
  readonly status: ActivityGroupStatus;
  readonly expanded: boolean;
  readonly toolCount: number;
  readonly tools: readonly ToolDescriptor[];
}

export interface ActivityProjectionOptions {
  /** Mark only the final group live when runtime state says work is active. */
  readonly liveTail?: boolean;
  readonly expandedIds?: ReadonlySet<string>;
  readonly groupId?: (group: ActivityGroup, index: number) => string;
  readonly failed?: (
    group: ActivityGroup,
    tools: readonly ToolDescriptor[],
  ) => boolean;
}

function titleFor(
  entries: readonly TranscriptEntry[],
  group: ActivityGroup,
  tools: readonly ToolDescriptor[],
  completed: boolean,
): string {
  const withinGroup = entries.slice(group.start, group.end + 1);
  const preamble = withinGroup.find(
    (entry) =>
      entry.kind === 'assistant' &&
      entry.titleKind === 'preamble' &&
      entry.title,
  );
  if (preamble?.kind === 'assistant' && preamble.title) return preamble.title;
  const supplied = withinGroup
    .flatMap((entry) =>
      entry.kind === 'assistant' && entry.title ? [entry.title] : [],
    )
    .at(-1);
  return supplied ?? describeTools(tools, undefined, completed);
}

/**
 * Project the pure grouping result into the view model consumed by both
 * dashboard and TUI adapters. It is intentionally free of React/TUI types.
 */
export function projectActivityGroups(
  entries: readonly TranscriptEntry[],
  options: ActivityProjectionOptions = {},
): readonly ActivityGroupViewModel[] {
  const groups = groupTranscript(entries);
  return groups.map((group, index) => {
    const tools = entries
      .slice(group.start, group.end + 1)
      .filter(
        (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> =>
          entry.kind === 'tool',
      );
    const id =
      options.groupId?.(group, index) ?? `activity-group-${group.start}`;
    const failed =
      options.failed?.(group, tools) ?? hasUnresolvedToolFailure(tools);
    const streaming = entries
      .slice(group.start, group.end + 1)
      .some((entry) => entry.kind === 'assistant' && entry.streaming === true);
    const live =
      tools.some(
        (tool) => tool.status === 'pending' || tool.status === 'running',
      ) ||
      (options.liveTail === true && index === groups.length - 1);
    const status: ActivityGroupStatus = failed
      ? 'failed'
      : streaming
        ? 'preparing'
        : live
          ? 'live'
          : 'complete';
    return {
      id,
      start: group.start,
      end: group.end,
      kind: activityKind(tools),
      title: titleFor(entries, group, tools, status !== 'live'),
      status,
      expanded: options.expandedIds?.has(id) ?? false,
      toolCount: tools.length,
      tools,
    };
  });
}
