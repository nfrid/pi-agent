import type { SessionBranchPoint } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  indexBranchPointsById,
  indexBranchPointsByMessageId,
} from './branching';

describe('transcript branching lookup', () => {
  it('maps nested message IDs for outline and bubble lookup', () => {
    const point: SessionBranchPoint = {
      id: 'anchor-entry',
      paths: [
        {
          id: 'choice-a-entry',
          messageId: 'choice-a',
          label: 'A',
          current: false,
        },
        {
          id: 'choice-b-entry',
          messageId: 'choice-b',
          label: 'B',
          current: true,
        },
      ],
    };
    const lookup = indexBranchPointsByMessageId({ points: [point] });

    expect(lookup.get('choice-a')).toBe(point);
    expect(lookup.get('choice-b')).toBe(point);
    expect(lookup.get('choice-a-entry')).toBeUndefined();
    expect(lookup.get('anchor-entry')).toBeUndefined();
    expect(indexBranchPointsById({ points: [point] }).get('anchor-entry')).toBe(
      point,
    );
  });
});
