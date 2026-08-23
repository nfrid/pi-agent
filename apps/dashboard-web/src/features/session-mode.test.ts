import { describe, expect, it } from 'vitest';
import { sessionAllowsControls } from './session';

describe('session interaction mode', () => {
  it('keeps delegate transcripts read-only', () => {
    expect(sessionAllowsControls({ sessionKind: 'delegate' })).toBe(false);
    expect(sessionAllowsControls({})).toBe(true);
  });
});
