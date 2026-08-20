import type { AuthoritativeSessionSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CachedSessionTranscript,
  decodeCachedSessionTranscript,
  InMemorySessionTranscriptCache,
} from './session-transcript-cache.js';

function snapshot(
  sessionId = 'session-a',
  serverId = 'server-a',
): AuthoritativeSessionSnapshot {
  return {
    serverId,
    cursor: 4,
    metadata: { id: sessionId, file: '', cwd: '/tmp', updatedAt: 10 },
    entries: [],
    history: { version: 1, start: 0, end: 0, hasOlder: false },
    entriesComplete: true,
    active: {
      messages: [],
      tools: [],
      delegates: [],
      truncated: false,
    },
    completeThroughCursor: true,
  };
}

function cached(
  sessionId = 'session-a',
  serverId = 'server-a',
  savedAt = 1,
): CachedSessionTranscript {
  return {
    version: 1,
    serverId,
    sessionId,
    savedAt,
    acceptedSequence: 4,
    snapshot: snapshot(sessionId, serverId),
    projection: {
      sessionId,
      order: [],
      items: {},
      lastCursor: 4,
      lastRuntimeSeq: 0,
      retiredEpochs: [],
    },
  };
}

describe('session transcript cache', () => {
  it('decodes a valid version-one value and enforces identity', () => {
    const value = cached();
    expect(
      decodeCachedSessionTranscript(value, {
        expectedServerId: 'server-a',
        expectedSessionId: 'session-a',
      }),
    ).toEqual(value);
    expect(
      decodeCachedSessionTranscript(value, {
        expectedServerId: 'other-server',
      }),
    ).toBeUndefined();
    expect(
      decodeCachedSessionTranscript(value, {
        expectedSessionId: 'other-session',
      }),
    ).toBeUndefined();
  });

  it.each([
    ['schema mismatch', { version: 2 }],
    ['corrupt projection', { projection: null }],
    ['corrupt snapshot', { snapshot: { serverId: 'server-a' } }],
    [
      'server mismatch inside snapshot',
      { snapshot: snapshot('session-a', 'other-server') },
    ],
  ])('rejects %s', (_label, patch) => {
    expect(
      decodeCachedSessionTranscript({ ...cached(), ...patch }),
    ).toBeUndefined();
  });

  it('uses a bounded access-order LRU in memory', async () => {
    const cache = new InMemorySessionTranscriptCache({
      maxEntries: 2,
      serverId: 'server-a',
    });
    await cache.save(cached('a', 'server-a', 1));
    await cache.save(cached('b', 'server-a', 2));
    await cache.load('a');
    await cache.save(cached('c', 'server-a', 3));
    expect(await cache.load('a')).toBeDefined();
    expect(await cache.load('b')).toBeUndefined();
    expect(await cache.load('c')).toBeDefined();
  });

  it('removes malformed values rather than exposing them', async () => {
    const cache = new InMemorySessionTranscriptCache({ serverId: 'server-a' });
    await cache.save(cached());
    // The cast models data tampered with in an actual storage backend.
    (cache as unknown as { values: Map<string, unknown> }).values.set(
      'session-a',
      {
        ...cached(),
        version: 99,
      },
    );
    expect(await cache.load('session-a')).toBeUndefined();
    expect(await cache.load('session-a')).toBeUndefined();
  });
});
