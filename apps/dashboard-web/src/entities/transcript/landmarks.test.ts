import { describe, expect, it } from 'vitest';
import {
  sampleTranscriptLandmarks,
  sampleTranscriptMinimapLandmarks,
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
    kind: userIndexes.has(index) ? 'user' : 'activity',
    itemIndex: index,
  }));
}

describe('transcript landmark sampling', () => {
  it('retains every user landmark before sampling activity landmarks', () => {
    const input = landmarks(300, [2, 100, 297]);
    const sampled = sampleTranscriptLandmarks(input, 8);

    expect(sampled).toHaveLength(8);
    expect(
      sampled
        .filter((landmark) => landmark.kind === 'user')
        .map((landmark) => landmark.itemIndex),
    ).toEqual([2, 100, 297]);
    expect(sampled.map((landmark) => landmark.itemIndex)).toEqual(
      [...sampled]
        .sort((left, right) => left.itemIndex - right.itemIndex)
        .map((landmark) => landmark.itemIndex),
    );
  });

  it('samples users themselves when they exceed the drawer cap', () => {
    const sampled = sampleTranscriptLandmarks(
      landmarks(
        300,
        Array.from({ length: 300 }, (_, index) => index),
      ),
      8,
    );

    expect(sampled).toHaveLength(8);
    expect(sampled.every((landmark) => landmark.kind === 'user')).toBe(true);
    expect(sampled[0]?.itemIndex).toBe(0);
    expect(sampled.at(-1)?.itemIndex).toBe(299);
  });

  it('keeps minimap sampling independent from drawer sampling', () => {
    const input = landmarks(300, [2, 100, 297]);
    const sampled = sampleTranscriptMinimapLandmarks(input, 4);

    expect(sampled).toHaveLength(4);
    expect(sampled[0]?.itemIndex).toBe(0);
    expect(sampled.at(-1)?.itemIndex).toBe(299);
  });
});
