import { describe, expect, it } from 'vitest';
import {
  distanceFromScrollEnd,
  FOLLOW_REARM_DISTANCE_PX,
  nextFollowMode,
} from './scroll';

describe('session follow mode', () => {
  it('rearms only within 40 pixels of the real content end', () => {
    expect(FOLLOW_REARM_DISTANCE_PX).toBe(40);
    expect(nextFollowMode('manual', 41, false)).toBe('manual');
    expect(nextFollowMode('manual', 40, false)).toBe('following');
  });

  it('treats upward intent as manual even at the content end', () => {
    expect(nextFollowMode('following', 0, true)).toBe('manual');
    expect(nextFollowMode('manual', 0, true)).toBe('manual');
  });

  it('keeps following while layout growth moves the end away', () => {
    expect(nextFollowMode('following', 200, false)).toBe('following');
  });

  it('calculates distance from the scroll element rather than the window', () => {
    expect(distanceFromScrollEnd(1_000, 600, 300)).toBe(100);
    expect(distanceFromScrollEnd(1_000, 800, 300)).toBe(0);
  });
});
