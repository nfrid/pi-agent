import { describe, expect, it } from 'vitest';
import {
  parseSessionFeedInput,
  parseSessionFeedMessage,
  parseShellFeedInput,
  parseShellFeedMessage,
  tryParseSessionFeedMessage,
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
    expect(
      parseShellFeedMessage({
        type: 'shell-event',
        sequence: 5,
        domain: 'usage',
        revision: 6,
        data: { usage: { refresh: true } },
      }),
    ).toMatchObject({ type: 'shell-event', sequence: 5 });
    expect(
      parseSessionFeedMessage({
        type: 'session-event',
        sequence: 6,
        sessionId: 'session-a',
        event: { type: 'agent.settled', sessionId: 'session-a' },
      }),
    ).toMatchObject({ type: 'session-event', sequence: 6 });
  });

  it('rejects numeric, credential-like, and unknown feed fields', () => {
    expect(() => parseShellFeedInput({ after: 'cursor-opaque' })).toThrow();
    expect(() => parseShellFeedInput({ after: 4 })).toThrow();
    expect(() => parseShellFeedInput({ lastEventId: 4 })).toThrow();
    expect(() => parseShellFeedInput({ cursor: '4' })).toThrow();
    expect(
      tryParseShellFeedMessage({ type: 'caught-up', sequence: -1 }),
    ).toBeUndefined();
    expect(
      tryParseShellFeedMessage({
        type: 'shell-event',
        domain: 'usage',
        revision: 1,
        data: {},
      }),
    ).toBeUndefined();
    expect(
      tryParseShellFeedMessage({
        type: 'shell-event',
        sequence: 1,
        domain: 'invalidation',
        revision: 1,
        data: { refresh: true },
      }),
    ).toBeUndefined();
    expect(
      tryParseSessionFeedMessage({
        type: 'session-event',
        sessionId: 'session-a',
        event: { type: 'agent.settled', sessionId: 'session-a' },
      }),
    ).toBeUndefined();
  });
});
