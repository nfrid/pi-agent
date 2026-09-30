import type { AuthoritativeSessionSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { DashboardLiveStore } from './store.js';

const closure = {
  id: 'closure-entry',
  type: 'custom' as const,
  customType: 'response-closure' as const,
  data: {
    requestMessageId: 'user-entry',
    finalMessageId: 'answer-entry',
    startedAt: 10,
    endedAt: 20,
    liveRequestMessageId: 'live-user',
    liveFinalMessageId: 'live-answer',
  },
};

function snapshot(
  entries: unknown[] = [],
  cursor = 0,
): AuthoritativeSessionSnapshot {
  return {
    serverId: 'daemon',
    cursor,
    metadata: {
      id: 'session',
      file: '/tmp/session.jsonl',
      cwd: '/tmp',
      updatedAt: 20,
    },
    entries,
    entriesComplete: true,
    active: { messages: [], tools: [], delegates: [], truncated: false },
    completeThroughCursor: true,
  };
}

describe('response closure in the live store', () => {
  it('retains the live marker and reconciles its exact persisted identity', () => {
    const store = new DashboardLiveStore();
    store.hydrateSession(snapshot());
    for (const [cursor, messageId, role, content, timestamp] of [
      [1, 'live-user', 'user', 'Request', 10],
      [2, 'live-answer', 'assistant', 'Answer', 20],
    ] as const) {
      expect(
        store.applyEventEnvelope({
          cursor,
          emittedAt: timestamp,
          sessionId: 'session',
          event: {
            type: 'message.finished',
            sessionId: 'session',
            message: { messageId, role, content, timestamp, phase: 'finished' },
          },
        }),
      ).toBe(true);
    }
    const event = {
      cursor: 3,
      emittedAt: 20,
      sessionId: 'session',
      event: { type: 'agent.settled' as const, sessionId: 'session', closure },
    };
    expect(store.applyEventEnvelope(event)).toBe(true);
    expect(
      store.getSnapshot().transcriptsBySessionId.session?.items[closure.id],
    ).toEqual({
      kind: 'other',
      id: closure.id,
      raw: closure,
    });
    expect(store.applyEventEnvelope(event)).toBe(false);
    store.hydrateSession(
      snapshot(
        [
          {
            type: 'message',
            id: 'user-entry',
            message: { role: 'user', content: 'Request', timestamp: 10 },
          },
          {
            type: 'message',
            id: 'answer-entry',
            message: { role: 'assistant', content: 'Answer', timestamp: 20 },
          },
          closure,
        ],
        3,
      ),
    );
    const projection = store.getSnapshot().transcriptsBySessionId.session;
    expect(projection?.order.filter((id) => id === closure.id)).toHaveLength(1);
    expect(projection?.items[closure.id]).toEqual({
      kind: 'other',
      id: closure.id,
      raw: closure,
    });
  });
});
