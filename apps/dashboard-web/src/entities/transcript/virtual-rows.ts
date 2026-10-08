import { toolBaseName } from '@pi-dashboard/activity-model';
import type { SessionBranchTopology } from '@pi-dashboard/protocol';
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
  | 'textPhase'
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
      !item?.textPhase?.hasPhase &&
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
      !items[historyStart - 1]?.workLogClosure &&
      !items[historyStart - 1]?.textPhase?.hasPhase;
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
  | {
      kind: 'entry';
      key: string;
      index: number;
      text?: string;
      showThinking?: boolean;
    }
  | { kind: 'tool-stream'; key: string; start: number; end: number }
  | {
      kind: 'work-log';
      key: string;
      start: number;
      end: number;
      durationMs: number;
      actionCount?: number;
      requestOrdinal?: number;
      requestId?: string;
      expanded: boolean;
    };

export function workLogTranscriptScopeKey(
  sessionId: string,
  branchTopology: SessionBranchTopology | undefined,
): string {
  const activePaths = (branchTopology?.points ?? [])
    .flatMap((point) => {
      const current = point.paths
        .filter((candidate) => candidate.current)
        .map((candidate) => candidate.id)
        .sort();
      return current.length > 0 ? [[point.id, current] as const] : [];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([sessionId, activePaths]);
}

export function isNewWorkLogClosureAppend(
  closure: NonNullable<TranscriptModelItem['workLogClosure']>,
  items: readonly TranscriptModelItem[],
  previousItems: readonly TranscriptModelItem[] | undefined,
): boolean {
  if (!previousItems || previousItems.length === 0) return false;
  if (!previousItems.every((item, index) => items[index]?.key === item.key))
    return false;
  const finalIndex = items.findIndex(
    (item) =>
      item.key === closure.finalMessageId ||
      item.key === closure.liveFinalMessageId,
  );
  return finalIndex >= 0;
}

/** Build the authoritative flat row plan for regular and virtual rendering. */
export function buildVirtualTranscriptRows(
  items: readonly ToolStreamItem[],
  open: ReadonlySet<string> = new Set(),
  options: {
    outline?: readonly import('@pi-dashboard/protocol').SessionOutlineLandmark[];
    historyStart?: number;
  } = {},
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

  type WorkLogCandidate = {
    closure: NonNullable<ToolStreamItem['workLogClosure']>;
    requestIndex: number;
    finalIndex: number;
    requestOrdinal?: number;
    requestId?: string;
    partial: boolean;
  };
  const candidates = items.flatMap<WorkLogCandidate>((item) => {
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
    if (finals.length !== 1 || finals[0]?.candidate.role !== 'assistant')
      return [];
    const finalIndex = finals[0].index;
    if (requests.length === 0) {
      const outlinedRequests = (options.outline ?? []).filter(
        (landmark) =>
          requestIds.includes(landmark.id) && landmark.kind === 'user',
      );
      const requestOrdinal = outlinedRequests[0]?.ordinal;
      const historyStart = options.historyStart;
      if (
        outlinedRequests.length !== 1 ||
        outlinedRequests[0]?.deliveryMode === 'steer' ||
        historyStart === undefined ||
        requestOrdinal === undefined ||
        requestOrdinal >= historyStart ||
        (options.outline ?? []).some(
          (landmark) =>
            landmark.kind === 'user' &&
            landmark.deliveryMode !== 'steer' &&
            landmark.ordinal > requestOrdinal &&
            landmark.ordinal < historyStart,
        ) ||
        items
          .slice(0, finalIndex)
          .some(
            (candidate) =>
              candidate.role === 'user' && candidate.deliveryMode !== 'steer',
          )
      )
        return [];
      return [
        {
          closure,
          requestIndex: -1,
          requestOrdinal,
          requestId: outlinedRequests[0]?.id,
          finalIndex,
          partial: true,
        },
      ];
    }
    if (
      requests.length !== 1 ||
      requests[0]?.candidate.role !== 'user' ||
      requests[0].candidate.deliveryMode === 'steer'
    )
      return [];
    const requestIndex = requests[0].index;
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
    return [{ closure, requestIndex, finalIndex, partial: false }];
  });
  const overlaps = (
    left: WorkLogCandidate,
    right: WorkLogCandidate,
  ): boolean => {
    if (left.partial && right.partial) return true;
    if (left.partial) return right.requestIndex <= left.finalIndex;
    if (right.partial) return left.requestIndex <= right.finalIndex;
    return (
      left.requestIndex <= right.finalIndex &&
      right.requestIndex <= left.finalIndex
    );
  };
  const ranges = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other !== candidate && overlaps(candidate, other),
      ),
  );
  for (const {
    closure,
    requestIndex,
    requestOrdinal,
    requestId,
    finalIndex,
    partial,
  } of ranges.sort((left, right) => right.requestIndex - left.requestIndex)) {
    let start = partial ? 0 : requestIndex + 1;
    let end = finalIndex - 1;
    const finalMessage = items[finalIndex];
    const phasedEmptyRange =
      start > end &&
      finalMessage?.textPhase?.hasPhase &&
      (finalMessage.textPhase.fallbackText !== (finalMessage.text ?? '') ||
        Boolean(finalMessage.thinking?.length));
    if (start > end && !partial && !phasedEmptyRange) continue;
    if (phasedEmptyRange) {
      start = finalIndex;
      end = finalIndex;
    }
    const key = `work-log-${closure.finalMessageId}`;
    const expanded = open.has(key);
    const interior = result.filter((row) =>
      row.kind === 'entry'
        ? row.index >= start && row.index <= end
        : row.kind === 'tool-stream' && row.start >= start && row.end <= end,
    );
    const markedAnswers = items.flatMap((item, index) =>
      index >= start &&
      (index < finalIndex || (phasedEmptyRange && index === finalIndex)) &&
      item.textPhase?.hasAnswer
        ? [{ item, index }]
        : [],
    );
    const answerIndexes = new Set(markedAnswers.map(({ index }) => index));
    if (
      phasedEmptyRange &&
      finalMessage &&
      (finalMessage.textPhase?.fallbackText ||
        finalMessage.errorMessage ||
        finalMessage.imageCount)
    )
      answerIndexes.add(finalIndex);
    const finalRow = result.find(
      (row): row is Extract<VirtualTranscriptRow, { kind: 'entry' }> =>
        row.kind === 'entry' && row.index === finalIndex,
    );
    const firstInterior = interior[0];
    const insertionRow =
      firstInterior ??
      (partial
        ? result.find((row) =>
            row.kind === 'entry'
              ? row.index === finalIndex
              : row.kind === 'tool-stream' &&
                row.start <= finalIndex &&
                row.end >= finalIndex,
          )
        : undefined);
    if (!insertionRow) continue;
    const insertion = result.indexOf(insertionRow);
    const hidden = new Set(
      expanded
        ? []
        : interior.filter(
            (row) => row.kind !== 'entry' || !answerIndexes.has(row.index),
          ),
    );
    if (!expanded) {
      for (const row of result) {
        if (row.kind !== 'entry' || row.index < start || row.index > end)
          continue;
        const item = items[row.index];
        if (!item?.textPhase?.hasAnswer) continue;
        row.text = item.textPhase.answerText;
        row.showThinking = false;
      }
      if (finalMessage?.textPhase?.hasPhase && finalRow) {
        finalRow.text = finalMessage.textPhase.fallbackText;
        finalRow.showThinking = false;
      }
      if (
        finalMessage?.textPhase?.hasPhase &&
        !finalMessage.textPhase.fallbackText &&
        !finalMessage.errorMessage &&
        !finalMessage.imageCount &&
        finalRow
      )
        hidden.add(finalRow);
    }
    result.splice(insertion, 0, {
      kind: 'work-log',
      key,
      start,
      end,
      durationMs: closure.endedAt - closure.startedAt,
      ...(partial
        ? {
            requestOrdinal,
            requestId,
          }
        : {
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
          }),
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
