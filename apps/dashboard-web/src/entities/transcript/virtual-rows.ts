import type { TranscriptModelItem } from '../../transcript';

export type TranscriptToolStreamRange = {
  key: string;
  start: number;
  end: number;
};

/** Return contiguous ranges whose items are canonical tool calls. */
export function buildTranscriptToolStreams(
  items: readonly Pick<TranscriptModelItem, 'key' | 'tool'>[],
): TranscriptToolStreamRange[] {
  const result: TranscriptToolStreamRange[] = [];
  let index = 0;
  while (index < items.length) {
    if (!items[index]?.tool) {
      index += 1;
      continue;
    }
    const start = index;
    while (index + 1 < items.length && items[index + 1]?.tool) index += 1;
    const key = items[start]?.key ?? `tool-stream-${start}`;
    result.push({ key, start, end: index });
    index += 1;
  }
  return result;
}

export type VirtualTranscriptRow =
  | { kind: 'entry'; key: string; index: number }
  | { kind: 'tool-stream'; key: string; start: number; end: number };

/** Build the same flat rows used by the regular and virtual transcript views. */
export function buildVirtualTranscriptRows(
  items: readonly Pick<TranscriptModelItem, 'key' | 'tool'>[],
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
