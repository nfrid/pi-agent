import { describe, expect, it } from 'vitest';
import {
  parseBridgeEvent,
  tryParseBridgeEvent,
  tryParseResponseClosure,
} from './index.js';

const closure = {
  requestMessageId: 'user-entry',
  finalMessageId: 'assistant-entry',
  startedAt: 100,
  endedAt: 200,
  liveRequestMessageId: 'live-user',
  liveFinalMessageId: 'live-assistant',
};

describe('response closure protocol contract', () => {
  it('rejects nonfinite, negative, and reversed intervals', () => {
    expect(tryParseResponseClosure(closure)).toEqual(closure);
    for (const malformed of [
      { ...closure, startedAt: Number.NaN },
      { ...closure, endedAt: Number.POSITIVE_INFINITY },
      { ...closure, startedAt: -1 },
      { ...closure, endedAt: 99 },
    ])
      expect(tryParseResponseClosure(malformed)).toBeUndefined();
  });

  it('accepts old settled events and the raw marker event payload', () => {
    expect(parseBridgeEvent({ type: 'agent.settled', sessionId: 's' })).toEqual(
      {
        type: 'agent.settled',
        sessionId: 's',
      },
    );
    expect(
      parseBridgeEvent({
        type: 'agent.settled',
        sessionId: 's',
        closure: {
          id: 'marker-entry',
          type: 'custom',
          customType: 'response-closure',
          data: closure,
        },
      }),
    ).toMatchObject({ closure: { id: 'marker-entry', data: closure } });
    expect(
      tryParseBridgeEvent({
        type: 'agent.settled',
        sessionId: 's',
        closure: {
          id: 'marker-entry',
          type: 'custom',
          customType: 'response-closure',
          data: { ...closure, endedAt: 1 },
        },
      }),
    ).toBeUndefined();
  });
});
