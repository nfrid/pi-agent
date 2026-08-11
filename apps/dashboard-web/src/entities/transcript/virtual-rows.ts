import type { TranscriptModelItem } from '../../transcript';
import type { TranscriptGroup } from './activity';

export function buildTranscriptGroupCoverage(
  itemCount: number,
  groups: readonly TranscriptGroup[],
): {
  groupByStart: Map<number, TranscriptGroup>;
  groupCoverage: Uint8Array;
} {
  const groupByStart = new Map<number, TranscriptGroup>();
  const groupCoverage = new Uint8Array(itemCount);
  let groupIndex = 0;
  for (let index = 0; index < itemCount; index += 1) {
    while (groupIndex < groups.length) {
      const candidate = groups[groupIndex];
      if (!candidate || candidate.end >= index) break;
      groupIndex += 1;
    }
    const group = groups[groupIndex];
    if (!group) continue;
    groupByStart.set(group.start, group);
    if (group.start <= index && index <= group.end) groupCoverage[index] = 1;
  }
  // A group can start beyond the last item only for malformed external input;
  // retain the start map without letting it affect the coverage scan.
  for (const group of groups)
    if (!groupByStart.has(group.start)) groupByStart.set(group.start, group);
  return { groupByStart, groupCoverage };
}

export type VirtualTranscriptRow =
  | { kind: 'entry'; key: string; index: number }
  | { kind: 'group'; key: string; group: TranscriptGroup };

export type VirtualTranscriptRowBuildStats = { groupReads: number };

/**
 * Collapse covered transcript entries into group rows with a single sorted group
 * pointer. Callers must provide valid, sorted, disjoint ranges (the direct
 * output of groupTranscript); under that assumption this is O(items + groups),
 * not a groups.some scan for every item.
 */
export function buildVirtualTranscriptRows(
  items: readonly Pick<TranscriptModelItem, 'key'>[],
  groups: readonly TranscriptGroup[],
  stats?: VirtualTranscriptRowBuildStats,
): VirtualTranscriptRow[] {
  const result: VirtualTranscriptRow[] = [];
  let groupIndex = 0;
  for (let index = 0; index < items.length; index += 1) {
    while (groupIndex < groups.length) {
      if (stats) stats.groupReads += 1;
      const candidate = groups[groupIndex];
      if (!candidate || candidate.end >= index) break;
      groupIndex += 1;
    }
    const group = groups[groupIndex];
    if (stats) stats.groupReads += 1;
    if (group?.start === index) {
      const groupKey = items[group.start]?.key ?? `group-${group.start}`;
      result.push({ kind: 'group', key: `group-${groupKey}`, group });
    } else if (!group || index <= group.start || index > group.end) {
      result.push({
        kind: 'entry',
        key: items[index]?.key ?? `entry-${index}`,
        index,
      });
    }
  }
  return result;
}
