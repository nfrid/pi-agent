import type { NormalizedMessagePayload } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  createTranscriptProjection,
  reduceTranscriptEvent,
} from '../../packages/dashboard-domain/src/transcript';
import { LiveEventNormalizer } from './live-event-normalizer';

describe('live message identity', () => {
  it('retains the user prompt after a system lifecycle with the same timestamp', () => {
    const normalizer = new LiveEventNormalizer('runtime-resume');
    let projection = createTranscriptProjection('session-resume');
    // The SDK emits each initial message start/end in order. On resume the
    // system checkpoint and user prompt can be created in the same millisecond.
    for (const role of ['system', 'user', 'assistant']) {
      for (const phase of ['started', 'finished'] as const) {
        const message = normalizer.normalizeMessage(phase, {
          message: {
            role,
            timestamp: 1790610392011,
            content: `${role} content`,
          },
        });
        projection = reduceTranscriptEvent(projection, {
          type: phase === 'started' ? 'message.started' : 'message.finished',
          sessionId: 'session-resume',
          message,
        });
      }
    }
    expect(projection.order).toHaveLength(3);
    expect(projection.order.map((id) => projection.items[id])).toEqual(
      ['system', 'user', 'assistant'].map((role) =>
        expect.objectContaining({
          role,
          content: `${role} content`,
          status: 'finished',
        }),
      ),
    );
  });

  it('gives a delayed steering marker the same role-scoped user identity', () => {
    const normalizer = new LiveEventNormalizer('runtime-steer');
    const user = { role: 'user', timestamp: 123, content: 'Please check this' };
    const started = normalizer.normalizeMessage('started', { message: user });
    normalizer.normalizeMessage('finished', { message: user });
    normalizer.normalizeMessage('started', {
      message: { role: 'assistant', timestamp: 124, content: 'Checking' },
    });
    // remote-control intentionally normalizes delayed marks independently.
    const mark = new LiveEventNormalizer().normalizeMessage('updated', {
      message: { ...user, data: { deliveryMode: 'steer' } },
    });
    expect(mark.messageId).toBe(started.messageId);
    expect(mark.data).toEqual({ deliveryMode: 'steer' });
  });

  it('keeps assistant lifecycle identity when response ID appears only at completion', () => {
    const normalizer = new LiveEventNormalizer();
    const start = normalizer.normalizeMessage('started', {
      message: { role: 'assistant', timestamp: 123, content: [] },
    });
    const end: NormalizedMessagePayload = normalizer.normalizeMessage(
      'finished',
      {
        message: {
          role: 'assistant',
          timestamp: 123,
          responseId: 'response-1',
          content: 'Done',
        },
      },
    );
    expect(end.messageId).toBe(start.messageId);
  });
});
