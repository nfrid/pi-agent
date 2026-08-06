import { describe, expect, it } from 'vitest';
import { isIntentionalRightSwipe } from './swipe-to-dismiss';

describe('isIntentionalRightSwipe', () => {
  it('accepts a deliberate horizontal swipe to the right', () => {
    expect(
      isIntentionalRightSwipe({ absX: 96, absY: 18, vxvy: [0.48, 0.09] }),
    ).toBe(true);
  });

  it('rejects short, diagonal, and slow movement', () => {
    expect(
      isIntentionalRightSwipe({ absX: 60, absY: 4, vxvy: [0.5, 0.03] }),
    ).toBe(false);
    expect(
      isIntentionalRightSwipe({ absX: 96, absY: 80, vxvy: [0.48, 0.4] }),
    ).toBe(false);
    expect(
      isIntentionalRightSwipe({ absX: 96, absY: 8, vxvy: [0.08, 0.01] }),
    ).toBe(false);
  });
});
