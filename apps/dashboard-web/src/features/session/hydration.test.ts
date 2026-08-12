import { describe, expect, it } from 'vitest';
import { isCurrentSessionResponse } from './hydration';

describe('isCurrentSessionResponse', () => {
  it('accepts only a response for the current session ID', () => {
    const response = { metadata: { id: 'session-a' } };

    expect(isCurrentSessionResponse('session-a', response)).toBe(true);
    expect(isCurrentSessionResponse('session-b', response)).toBe(false);
    expect(isCurrentSessionResponse('session-a', undefined)).toBe(false);
  });
});
