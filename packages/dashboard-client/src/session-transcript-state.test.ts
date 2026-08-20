import { hydrateTranscript } from '@pi-dashboard/domain';
import type { DashboardEventEnvelope } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  acceptTranscriptEventOrdering,
  acceptTranscriptSnapshotOrdering,
  mergePrependedTranscript,
  reduceSessionTranscriptEvent,
} from './session-transcript-state.js';

describe('session transcript state', () => {
  it('accepts only the next event after sequence is known', () => {
    const current = { generation: 3, sequence: 7, sequenceKnown: true };

    expect(acceptTranscriptEventOrdering(current, 8, 3)).toEqual({
      accepted: true,
    });
    expect(acceptTranscriptEventOrdering(current, 7, 3)).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
    expect(acceptTranscriptEventOrdering(current, 9, 3)).toEqual({
      accepted: false,
      reason: 'gap',
    });
    expect(acceptTranscriptEventOrdering(current, 8, 4)).toEqual({
      accepted: false,
      reason: 'generation',
    });
  });

  it('allows an authoritative snapshot to establish a lower sequence', () => {
    const current = { generation: 3, sequence: 7, sequenceKnown: true };

    expect(acceptTranscriptSnapshotOrdering(current, 6, 3)).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
    expect(acceptTranscriptSnapshotOrdering(current, 6, 3, true)).toEqual({
      accepted: true,
    });
  });

  it('seeds a complete session snapshot event without prior projection', () => {
    const projection = reduceSessionTranscriptEvent(undefined, 'session-1', {
      cursor: 1,
      emittedAt: 1,
      sessionId: 'session-1',
      event: {
        type: 'session.snapshot',
        session: {
          id: 'session-1',
          entriesComplete: true,
          entries: [
            {
              type: 'message',
              id: 'seeded',
              message: { role: 'user', content: 'hello' },
            },
          ],
        },
      },
    } as DashboardEventEnvelope);

    expect(projection?.order).toEqual(['seeded']);
  });

  it('uses older-page order while retaining newer tool data', () => {
    const current = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'newer',
          message: { role: 'user', content: 'newer', timestamp: 200 },
        },
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: 'old',
            timestamp: 100,
          },
        },
        {
          type: 'message',
          message: {
            role: 'toolResult',
            toolCallId: 'old-tool',
            toolName: 'read',
            content: 'live result',
          },
        },
      ],
      'session-1',
      { fallbackEntryIds: true, fallbackEntryOffset: 10 },
    );
    const fallbackMessageId = current.order[1];
    expect(fallbackMessageId).toBeDefined();
    const older = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'persisted-old',
          message: {
            role: 'assistant',
            content: 'old',
            timestamp: 100,
          },
        },
        {
          type: 'message',
          message: {
            role: 'toolResult',
            toolCallId: 'old-tool',
            toolName: 'read',
            content: 'persisted result',
          },
        },
      ],
      'session-1',
      { fallbackEntryIds: true },
    );

    const merged = mergePrependedTranscript(current, older);
    expect(merged.order).toEqual(['persisted-old', 'old-tool', 'newer']);
    expect(merged.items[fallbackMessageId as string]).toBeUndefined();
    expect(merged.items['old-tool']).toMatchObject({ result: 'live result' });
  });
});
