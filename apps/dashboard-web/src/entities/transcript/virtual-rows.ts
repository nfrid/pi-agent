import { toolBaseName } from '@pi-dashboard/activity-model';
import type { TranscriptModelItem } from '../../transcript';

export type TranscriptToolStreamRange = {
  key: string;
  start: number;
  end: number;
};

type ToolStreamItem = Pick<
  TranscriptModelItem,
  | 'key'
  | 'tool'
  | 'role'
  | 'deliveryMode'
  | 'thinking'
  | 'text'
  | 'imageCount'
  | 'errorMessage'
  | 'entry'
  | 'event'
  | 'raw'
  | 'workLogClosure'
  | 'codemodeRootKey'
  | 'codemodeDescendants'
>;

function isThinkingOnly(item: ToolStreamItem | undefined): boolean {
  return Boolean(
    item?.role === 'assistant' &&
      item.thinking?.length &&
      !item.text &&
      !item.imageCount &&
      !item.errorMessage,
  );
}

function isContinuingEvent(item: ToolStreamItem | undefined): boolean {
  return Boolean(
    item?.event &&
      item.entry.kind === 'other' &&
      item.entry.continuesGroup === true,
  );
}

function isStreamHistory(item: ToolStreamItem | undefined): boolean {
  return Boolean(
    !item?.workLogClosure &&
      (item?.tool || isThinkingOnly(item) || isContinuingEvent(item)),
  );
}

/** Return tool ranges without letting thinking or continuing events split them. */
export function buildTranscriptToolStreams(
  items: readonly ToolStreamItem[],
): TranscriptToolStreamRange[] {
  const result: TranscriptToolStreamRange[] = [];
  let index = 0;
  while (index < items.length) {
    if (!isStreamHistory(items[index])) {
      index += 1;
      continue;
    }
    const historyStart = index;
    let hasTool = false;
    let hasThinking = false;
    while (index < items.length) {
      const item = items[index];
      if (!isStreamHistory(item)) break;
      if (item?.tool) hasTool = true;
      if (isThinkingOnly(item)) hasThinking = true;
      index += 1;
    }
    if (!hasTool && !hasThinking) continue;
    const hasPreambleThoughts =
      historyStart > 0 &&
      items[historyStart]?.tool &&
      items[historyStart - 1]?.role === 'assistant' &&
      Boolean(items[historyStart - 1]?.thinking?.length) &&
      !items[historyStart - 1]?.errorMessage &&
      !items[historyStart - 1]?.workLogClosure;
    const start = hasPreambleThoughts ? historyStart - 1 : historyStart;
    const key = items[start]?.key ?? `tool-stream-${start}`;
    result.push({ key, start, end: index - 1 });
  }
  return result;
}

export function shouldPreserveWorkLogOnAppend(
  closure: NonNullable<TranscriptModelItem['workLogClosure']>,
  items: readonly TranscriptModelItem[],
  streams: readonly TranscriptToolStreamRange[],
  openStreams: ReadonlySet<string>,
  openToolDetails: ReadonlySet<string>,
  scrollPhase: 'restoring' | 'following' | 'reading',
): boolean {
  if (scrollPhase !== 'following') return true;
  const requestIndex = items.findIndex(
    (item) =>
      item.key === closure.requestMessageId ||
      item.key === closure.liveRequestMessageId,
  );
  const finalIndex = items.findIndex(
    (item) =>
      item.key === closure.finalMessageId ||
      item.key === closure.liveFinalMessageId,
  );
  return (
    [...openToolDetails].some((key) => {
      const detailIndex = items.findIndex((item) => item.key === key);
      return detailIndex > requestIndex && detailIndex < finalIndex;
    }) ||
    streams.some(
      (stream) =>
        stream.start > requestIndex &&
        stream.end < finalIndex &&
        openStreams.has(stream.key),
    )
  );
}

export type VirtualTranscriptRow =
  | { kind: 'entry'; key: string; index: number }
  | { kind: 'tool-stream'; key: string; start: number; end: number }
  | {
      kind: 'work-log';
      key: string;
      start: number;
      end: number;
      durationMs: number;
      actionCount: number;
      expanded: boolean;
    };

/** Build the authoritative flat row plan for regular and virtual rendering. */
export function buildVirtualTranscriptRows(
  items: readonly ToolStreamItem[],
  open: ReadonlySet<string> = new Set(),
): VirtualTranscriptRow[] {
  const streams = buildTranscriptToolStreams(items);
  const streamByStart = new Map(
    streams.map((stream) => [stream.start, stream]),
  );
  const streamIndexes = new Uint8Array(items.length);
  for (const stream of streams)
    for (let index = stream.start; index <= stream.end; index += 1)
      streamIndexes[index] = 1;

  const result: VirtualTranscriptRow[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const stream = streamByStart.get(index);
    if (stream) {
      result.push({ kind: 'tool-stream', ...stream });
      continue;
    }
    if (!streamIndexes[index])
      result.push({
        kind: 'entry',
        key: items[index]?.key ?? `entry-${index}`,
        index,
      });
  }

  const candidates = items.flatMap((item) => {
    const closure = item.workLogClosure;
    if (!closure) return [];
    const requestIds = [
      closure.requestMessageId,
      closure.liveRequestMessageId,
    ].filter((id): id is string => typeof id === 'string');
    const finalIds = [
      closure.finalMessageId,
      closure.liveFinalMessageId,
    ].filter((id): id is string => typeof id === 'string');
    if (
      requestIds.length === 0 ||
      finalIds.length === 0 ||
      !Number.isFinite(closure.startedAt) ||
      !Number.isFinite(closure.endedAt) ||
      closure.endedAt < closure.startedAt
    )
      return [];
    const requests = items.flatMap((candidate, index) =>
      requestIds.includes(candidate.key) ? [{ candidate, index }] : [],
    );
    const finals = items.flatMap((candidate, index) =>
      finalIds.includes(candidate.key) ? [{ candidate, index }] : [],
    );
    if (
      requests.length !== 1 ||
      finals.length !== 1 ||
      requests[0]?.candidate.role !== 'user' ||
      requests[0].candidate.deliveryMode === 'steer' ||
      finals[0]?.candidate.role !== 'assistant'
    )
      return [];
    const requestIndex = requests[0].index;
    const finalIndex = finals[0].index;
    if (requestIndex >= finalIndex) return [];
    if (
      items
        .slice(requestIndex + 1, finalIndex)
        .some(
          (candidate) =>
            candidate.role === 'user' && candidate.deliveryMode !== 'steer',
        )
    )
      return [];
    return [{ closure, requestIndex, finalIndex }];
  });
  const ranges = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate &&
          candidate.requestIndex <= other.finalIndex &&
          other.requestIndex <= candidate.finalIndex,
      ),
  );
  for (const { closure, requestIndex, finalIndex } of ranges.sort(
    (left, right) => right.requestIndex - left.requestIndex,
  )) {
    const start = requestIndex + 1;
    const end = finalIndex - 1;
    if (start > end) continue;
    const key = `work-log-${closure.finalMessageId}`;
    const expanded = open.has(key);
    const interior = result.filter((row) =>
      row.kind === 'entry'
        ? row.index >= start && row.index <= end
        : row.kind === 'tool-stream' && row.start >= start && row.end <= end,
    );
    const firstInterior = interior[0];
    if (!firstInterior) continue;
    const insertion = result.indexOf(firstInterior);
    const hidden = new Set(interior);
    result.splice(insertion, 0, {
      kind: 'work-log',
      key,
      start,
      end,
      durationMs: closure.endedAt - closure.startedAt,
      actionCount: items
        .slice(start, end + 1)
        .filter(
          (candidate) =>
            candidate.tool &&
            !(
              toolBaseName(candidate.tool.name) === 'codemode' &&
              candidate.codemodeDescendants?.length
            ),
        ).length,
      expanded,
    });
    if (!expanded)
      for (let index = result.length - 1; index >= 0; index -= 1) {
        const row = result[index];
        if (row && hidden.has(row)) result.splice(index, 1);
      }
  }
  return result;
}
