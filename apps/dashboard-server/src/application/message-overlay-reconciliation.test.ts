import type { TranscriptProjection } from '@pi-dashboard/domain';
import { describe, expect, it } from 'vitest';
import { retirePersistedMessageOverlays } from './dashboard-application.js';

function projection(
  items: Record<
    string,
    {
      messageId: string;
      role: string;
      content: unknown;
      timestamp?: number;
      status: 'streaming' | 'finished';
    }
  >,
): TranscriptProjection {
  return {
    order: Object.keys(items),
    items: Object.fromEntries(
      Object.entries(items).map(([id, item]) => [
        id,
        { kind: 'message', ...item },
      ]),
    ),
    lastCursor: 0,
    lastRuntimeSeq: 0,
    retiredEpochs: [],
  } as TranscriptProjection;
}

describe('authoritative active message overlay reconciliation', () => {
  it('retires an older active message when the persisted branch contains it', () => {
    const active = projection({
      a: {
        messageId: 'a-live',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: 11,
        status: 'finished',
      },
    });
    const persisted = projection({
      a: {
        messageId: 'a-disk',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: 11,
        status: 'finished',
      },
    });
    expect(retirePersistedMessageOverlays(active, persisted).order).toEqual([]);
  });

  it('uses timestamps to distinguish repeated identical messages', () => {
    const active = projection({
      a: {
        messageId: 'new',
        role: 'assistant',
        content: 'same',
        timestamp: 20,
        status: 'finished',
      },
    });
    const persisted = projection({
      old: {
        messageId: 'old',
        role: 'assistant',
        content: 'same',
        timestamp: 10,
        status: 'finished',
      },
      new: {
        messageId: 'disk-new',
        role: 'assistant',
        content: 'same',
        timestamp: 20,
        status: 'finished',
      },
    });
    expect(retirePersistedMessageOverlays(active, persisted).order).toEqual([]);
  });

  it('keeps ambiguous same-timestamp messages and timestamp-less messages', () => {
    const active = projection({
      ambiguous: {
        messageId: 'live',
        role: 'assistant',
        content: 'same',
        timestamp: 10,
        status: 'finished',
      },
      noTimestamp: {
        messageId: 'live-no-time',
        role: 'assistant',
        content: 'same',
        status: 'finished',
      },
    });
    const persisted = projection({
      one: {
        messageId: 'disk-1',
        role: 'assistant',
        content: 'same',
        timestamp: 10,
        status: 'finished',
      },
      two: {
        messageId: 'disk-2',
        role: 'assistant',
        content: 'same',
        timestamp: 10,
        status: 'finished',
      },
      noTimestamp: {
        messageId: 'different',
        role: 'assistant',
        content: 'same',
        status: 'finished',
      },
    });
    expect(retirePersistedMessageOverlays(active, persisted).order).toEqual([
      'ambiguous',
      'noTimestamp',
    ]);
  });

  it('preserves a running partial message whose content differs', () => {
    const active = projection({
      a: {
        messageId: 'same-id',
        role: 'assistant',
        content: 'partial update',
        timestamp: 10,
        status: 'streaming',
      },
    });
    const persisted = projection({
      a: {
        messageId: 'same-id',
        role: 'assistant',
        content: 'complete prior',
        timestamp: 10,
        status: 'finished',
      },
    });
    expect(retirePersistedMessageOverlays(active, persisted).order).toEqual([
      'a',
    ]);
  });
});
