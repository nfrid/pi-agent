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
  | 'thinking'
  | 'text'
  | 'imageCount'
  | 'entry'
  | 'event'
>;

function isThinkingOnly(item: ToolStreamItem | undefined): boolean {
  return Boolean(
    item?.role === 'assistant' &&
      item.thinking?.length &&
      !item.text &&
      !item.imageCount,
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
  return Boolean(item?.tool || isThinkingOnly(item) || isContinuingEvent(item));
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
    while (index < items.length) {
      const item = items[index];
      if (!isStreamHistory(item)) break;
      if (item?.tool) hasTool = true;
      index += 1;
    }
    if (!hasTool) continue;
    const hasPreambleThoughts =
      historyStart > 0 &&
      items[historyStart]?.tool &&
      items[historyStart - 1]?.role === 'assistant' &&
      Boolean(items[historyStart - 1]?.thinking?.length);
    const start = hasPreambleThoughts ? historyStart - 1 : historyStart;
    const key = items[start]?.key ?? `tool-stream-${start}`;
    result.push({ key, start, end: index - 1 });
  }
  return result;
}

export type VirtualTranscriptRow =
  | { kind: 'entry'; key: string; index: number }
  | { kind: 'tool-stream'; key: string; start: number; end: number };

/** Build the same flat rows used by the regular and virtual transcript views. */
export function buildVirtualTranscriptRows(
  items: readonly ToolStreamItem[],
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
    if (!streamIndexes[index]) {
      result.push({
        kind: 'entry',
        key: items[index]?.key ?? `entry-${index}`,
        index,
      });
    }
  }
  return result;
}
