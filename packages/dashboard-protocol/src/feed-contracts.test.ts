import { describe, expect, it } from 'vitest';
import {
  parseSessionFeedInput,
  parseShellFeedInput,
  parseShellFeedMessage,
  tryParseShellFeedMessage,
} from './parsers.js';

describe('feed protocol contracts', () => {
  it('accepts strict inputs and caught-up messages', () => {
    expect(parseShellFeedInput({})).toEqual({});
    expect(parseShellFeedInput({ lastEventId: 'cursor-opaque' })).toEqual({
      lastEventId: 'cursor-opaque',
    });
    expect(
      parseSessionFeedInput({
        sessionId: 'session-a',
        lastEventId: 'cursor-opaque',
      }),
    ).toEqual({ sessionId: 'session-a', lastEventId: 'cursor-opaque' });
    expect(parseShellFeedMessage({ type: 'caught-up', sequence: 4 })).toEqual({
      type: 'caught-up',
      sequence: 4,
    });
  });

  it('rejects numeric, credential-like, and unknown feed fields', () => {
    expect(() => parseShellFeedInput({ after: 4 })).toThrow();
    expect(() => parseShellFeedInput({ lastEventId: 4 })).toThrow();
    expect(() => parseShellFeedInput({ cursor: '4' })).toThrow();
    expect(
      tryParseShellFeedMessage({ type: 'caught-up', sequence: -1 }),
    ).toBeUndefined();
  });
});
