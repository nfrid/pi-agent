import type {
  AuthoritativeSessionSnapshot,
  BrowserSnapshot,
} from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CachedSessionTranscript,
  decodeCachedSessionTranscript,
  InMemorySessionTranscriptCache,
} from './session-transcript-cache.js';
import { DashboardLiveStore } from './store.js';

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

function browserSnapshot(serverId = 'server-a'): BrowserSnapshot {
  return {
    serverId,
    revision: 1,
    cursor: 1,
    runtimes: [],
    sessions: [],
    unread: [],
  };
}

function productionCachedWithCoverage(): CachedSessionTranscript {
  const store = new DashboardLiveStore();
  store.installSnapshot(browserSnapshot());
  store.beginSessionSync('session-a', 1);
  const initial = {
    ...snapshot(),
    cursor: 4,
    entries: [
      {
        type: 'message',
        id: 'newest',
        message: { role: 'user', content: 'newest' },
      },
    ],
    history: {
      version: 1 as const,
      start: 10,
      end: 20,
      hasOlder: true,
      nextBefore: 'before-10',
    },
  } satisfies AuthoritativeSessionSnapshot;
  if (!store.acceptSessionSnapshot(initial, 4, 1, true))
    throw new Error('Expected initial session snapshot');
  if (
    !store.prependSessionHistory({
      ...snapshot(),
      cursor: 4,
      entries: [
        {
          type: 'message',
          id: 'older-middle',
          message: { role: 'user', content: 'older middle' },
        },
      ],
      history: {
        version: 1,
        start: 5,
        end: 10,
        hasOlder: true,
        nextBefore: 'before-5',
      },
    })
  )
    throw new Error('Expected middle session history');
  if (
    !store.prependSessionHistory({
      ...snapshot(),
      cursor: 4,
      entries: [
        {
          type: 'message',
          id: 'older',
          message: { role: 'user', content: 'older' },
        },
      ],
      history: { version: 1, start: 0, end: 5, hasOlder: false },
    })
  )
    throw new Error('Expected older session history');

  store.hydrateSession({
    ...snapshot(),
    cursor: 5,
    entries: [
      {
        type: 'message',
        id: 'expanded-newest',
        message: { role: 'user', content: 'expanded newest' },
      },
    ],
    history: {
      version: 1,
      start: 5,
      end: 21,
      hasOlder: true,
      nextBefore: 'before-expanded',
    },
  });
  const value = store.cachedSessionTranscript('session-a');
  if (!value) throw new Error('Expected cached session transcript');
  return value;
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

  it('preserves projection boundary acceptance', () => {
    const duplicateOrder = cached();
    duplicateOrder.projection = {
      ...duplicateOrder.projection,
      order: ['item', 'item'],
      items: {
        item: {
          kind: 'other',
          id: 'item',
          raw: null,
        },
      },
    };
    expect(decodeCachedSessionTranscript(duplicateOrder)).toEqual(
      duplicateOrder,
    );

    const prototypeName = cached();
    prototypeName.projection = {
      ...prototypeName.projection,
      order: ['__proto__', '__proto__'],
      items: JSON.parse(
        '{"__proto__":{"kind":"other","id":"__proto__"}}',
      ) as unknown as CachedSessionTranscript['projection']['items'],
    };
    expect(decodeCachedSessionTranscript(prototypeName)).toEqual(prototypeName);

    const missingId = cached();
    missingId.projection = {
      ...missingId.projection,
      order: ['missing'],
    };
    expect(decodeCachedSessionTranscript(missingId)).toBeUndefined();

    const invalidUnorderedItem = cached();
    invalidUnorderedItem.projection = {
      ...invalidUnorderedItem.projection,
      items: {
        hidden: { kind: 'invalid' },
      } as unknown as CachedSessionTranscript['projection']['items'],
    };
    expect(decodeCachedSessionTranscript(invalidUnorderedItem)).toBeUndefined();
  });

  it('round-trips production-generated multipage coverage after a retained rebase', () => {
    const value = productionCachedWithCoverage();
    expect(value.coverage?.pages).toEqual([
      expect.objectContaining({ start: 0, end: 5 }),
      expect.objectContaining({ start: 5, end: 10 }),
      expect.objectContaining({ start: 5, end: 21 }),
    ]);
    expect(
      decodeCachedSessionTranscript(value, {
        expectedServerId: 'server-a',
        expectedSessionId: 'session-a',
      }),
    ).toEqual(value);
  });

  it('round-trips the production origin placeholder coverage shape', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(browserSnapshot());
    store.beginSessionSync('session-a', 1);
    expect(
      store.acceptSessionSnapshot({ ...snapshot(), cursor: 1 }, 1, 1, true),
    ).toBe(true);
    expect(
      store.prependSessionHistory({
        ...snapshot(),
        cursor: 1,
        entries: [
          {
            type: 'message',
            id: 'origin-entry',
            message: { role: 'user', content: 'origin' },
          },
        ],
        history: { version: 1, start: 0, end: 10, hasOlder: false },
      }),
    ).toBeDefined();
    const value = store.cachedSessionTranscript('session-a');
    expect(value?.coverage?.pages).toEqual([
      expect.objectContaining({ start: 0, end: 10 }),
      expect.objectContaining({ start: 0, end: 0 }),
    ]);
    expect(value).toBeDefined();
    expect(decodeCachedSessionTranscript(value)).toEqual(value);
  });

  it.each([
    [
      'inconsistent aggregate entry count',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        entryCount: (coverage?.entryCount ?? 0) + 1,
      }),
    ],
    [
      'inconsistent aggregate byte count',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        byteCount: (coverage?.byteCount ?? 0) + 1,
      }),
    ],
    [
      'inconsistent aggregate covered end',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        coveredEnd: (coverage?.coveredEnd ?? 0) + 1,
      }),
    ],
    [
      'inconsistent page ranges',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        pages: coverage?.pages.map((page, index) =>
          index === 1 ? { ...page, start: 11 } : page,
        ),
      }),
    ],
    [
      'missing pagination continuation',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        pages: coverage?.pages.map((page, index) =>
          index === 2 ? { ...page, nextBefore: undefined } : page,
        ),
      }),
    ],
    [
      'duplicate pagination cursor',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        pages: coverage?.pages.map((page, index) =>
          index === 1
            ? { ...page, nextBefore: coverage?.pages[2]?.nextBefore }
            : page,
        ),
      }),
    ],
    [
      'reversed page range',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        pages: coverage?.pages.map((page, index) =>
          index === 1 ? { ...page, start: 4, end: 3 } : page,
        ),
      }),
    ],
    [
      'conflicting page flags',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        pages: coverage?.pages.map((page, index) =>
          index === 0 ? { ...page, hasOlder: true } : page,
        ),
      }),
    ],
  ])('rejects %s in cached coverage', (_label, mutate) => {
    const value = productionCachedWithCoverage();
    expect(
      decodeCachedSessionTranscript({
        ...value,
        coverage: mutate(value.coverage),
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
