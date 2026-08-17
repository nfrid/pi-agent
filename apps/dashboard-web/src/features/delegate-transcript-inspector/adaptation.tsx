import type { DelegateTranscriptEntry } from '../../../../../extensions/delegate/contribution';
import { TranscriptEntry } from '../../entities/transcript/entries';
import type { TranscriptModelItem } from '../../transcript';
import { surfaceText } from '../delegate/surface-state';

function toolStatus(
  status: DelegateTranscriptEntry['status'],
): 'pending' | 'running' | 'success' | 'error' {
  if (status === 'error') return 'error';
  if (status === 'completed') return 'success';
  return status === 'running' ? 'running' : 'pending';
}

/**
 * Adapt the bounded public delegate stream to the main transcript entry
 * components. This deliberately consumes the live surface value as-is: it
 * never fetches a full session or reconstructs a transcript projection.
 */
export function delegateTranscriptItems(
  entries: readonly DelegateTranscriptEntry[],
): TranscriptModelItem[] {
  const occurrences = new Map<string, number>();
  return entries.map((entry) => {
    const baseKey = `${entry.run ?? 1}:${entry.id}`;
    const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
    occurrences.set(baseKey, occurrence);
    const key = occurrence === 1 ? baseKey : `${baseKey}:${occurrence}`;
    if (entry.type === 'task')
      return {
        key,
        entry: { kind: 'other' },
        raw: entry,
        text: surfaceText(entry.text),
        role: 'user',
      } as TranscriptModelItem;
    if (entry.type === 'thinking')
      return {
        key,
        entry: {
          kind: 'assistant',
          speaks: false,
          narration: 'thought',
        },
        raw: entry,
        thinking: entry.text ? [entry.text] : [],
        role: 'assistant',
      } as TranscriptModelItem;
    if (entry.type === 'tool') {
      const status = toolStatus(entry.status);
      const name = entry.name ?? entry.label;
      return {
        key,
        entry: {
          kind: 'tool',
          name,
          args: entry.arguments,
          status,
          ...(status === 'error' ? { isError: true } : {}),
        },
        raw: entry,
        tool: {
          kind: 'tool',
          key,
          toolCallId: key,
          name,
          ...(entry.arguments === undefined
            ? {}
            : { arguments: entry.arguments }),
          ...(entry.result === undefined ? {} : { result: entry.result }),
          status,
          ...(entry.text || entry.argumentsTruncated || entry.resultTruncated
            ? {
                data: {
                  ...(entry.text === undefined ? {} : { summary: entry.text }),
                  ...(entry.argumentsTruncated
                    ? { argumentsTruncated: true }
                    : {}),
                  ...(entry.resultTruncated ? { resultTruncated: true } : {}),
                },
              }
            : {}),
        },
      } as TranscriptModelItem;
    }
    if (entry.type === 'error')
      return {
        key,
        entry: { kind: 'other' },
        raw: entry,
        event: {
          kind: 'delegate-result',
          label: 'Delegate error',
          status: 'error',
          ...(entry.text ? { content: entry.text } : {}),
        },
      } as TranscriptModelItem;
    return {
      key,
      entry: { kind: 'assistant', speaks: true },
      raw: entry,
      text: surfaceText(entry.text),
      role: 'assistant',
    } as TranscriptModelItem;
  });
}

function delegateItemTimestamp(item: TranscriptModelItem): number | undefined {
  const raw = item.raw;
  return raw &&
    typeof raw === 'object' &&
    'at' in raw &&
    typeof raw.at === 'number'
    ? raw.at
    : undefined;
}

export function DelegateTranscript({
  entries,
  truncated = false,
  truncatedMessage = 'Earlier transcript entries were omitted from this live view.',
}: {
  entries: readonly DelegateTranscriptEntry[];
  truncated?: boolean;
  truncatedMessage?: string;
}) {
  const items = delegateTranscriptItems(entries);
  return (
    <section className="delegate-transcript" aria-label="Delegate transcript">
      {items.map((item) => (
        <TranscriptEntry
          item={item}
          key={item.key}
          timestampOverride={delegateItemTimestamp(item)}
        />
      ))}
      {truncated && (
        <p className="delegate-transcript-truncated">{truncatedMessage}</p>
      )}
    </section>
  );
}
