import type { SessionBranchPoint } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { indexBranchPointsByMemberId } from './branching';

describe('transcript branching lookup', () => {
  it('maps choice entries to their point without marking the anchor', () => {
    const point: SessionBranchPoint = {
      id: 'anchor',
      memberIds: ['choice-a', 'choice-b'],
      paths: [
        { id: 'choice-a', label: 'A', current: false },
        { id: 'choice-b', label: 'B', current: true },
      ],
    };
    const lookup = indexBranchPointsByMemberId({ points: [point] });

    expect(lookup.get('choice-a')).toBe(point);
    expect(lookup.get('choice-b')).toBe(point);
    expect(lookup.get('anchor')).toBeUndefined();
  });
});
