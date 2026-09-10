import { describe, expect, it } from 'vitest';
import {
  buildTranscriptLandmarks,
  clusterTranscriptUserTurns,
  selectTranscriptUserTurns,
  type TranscriptLandmark,
} from './landmarks';

function landmarks(
  count: number,
  users: readonly number[],
): TranscriptLandmark[] {
  const userIndexes = new Set(users);
  return Array.from({ length: count }, (_, index) => ({
    key: `landmark-${index}`,
    label: `landmark ${index}`,
    kind: userIndexes.has(index) ? 'user' : 'assistant',
    itemIndex: index,
  }));
}

describe('transcript landmark selection', () => {
  it('keeps raw assistant landmarks out of the user-turn outline contract', () => {
    const input = landmarks(5, [1, 4]);

    expect(
      selectTranscriptUserTurns(input).map((landmark) => landmark.key),
    ).toEqual(['landmark-1', 'landmark-4']);
  });

  it('clusters dense turns contiguously and keeps a representative anchor', () => {
    const input = landmarks(10, [0, 1, 2, 3, 4, 5]);
    const clusters = clusterTranscriptUserTurns(input, 3);

    expect(
      clusters.map((cluster) =>
        cluster.landmarks.map((landmark) => landmark.itemIndex),
      ),
    ).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    expect(clusters.map((cluster) => cluster.representative.itemIndex)).toEqual(
      [0, 2, 4],
    );
  });
});

describe('transcript user-turn landmarks', () => {
  it('retains custom labels for feature-owned user landmarks', () => {
    const [landmark] = buildTranscriptLandmarks([
      {
        key: 'delegate-request',
        entry: { kind: 'other' },
        raw: {},
        role: 'user',
        text: 'raw child prompt',
        landmark: {
          label: 'Review the inspector',
          typeLabel: 'Parent request',
          variant: 'delegate-request',
        },
      },
    ]);

    expect(landmark).toMatchObject({
      key: 'delegate-request',
      kind: 'user',
      label: 'Review the inspector',
      typeLabel: 'Parent request',
      variant: 'delegate-request',
    });
  });

  it('preserves every user turn even beyond the old drawer cap', () => {
    const turns = selectTranscriptUserTurns(
      landmarks(
        300,
        Array.from({ length: 300 }, (_, index) => index),
      ),
    );
    expect(turns).toHaveLength(300);
    expect(turns[0]?.itemIndex).toBe(0);
    expect(turns.at(-1)?.itemIndex).toBe(299);
    const clusters = clusterTranscriptUserTurns(turns, 14);
    expect(clusters.length).toBeLessThanOrEqual(14);
    expect(clusters.flatMap((cluster) => cluster.landmarks)).toEqual(turns);
  });
});
