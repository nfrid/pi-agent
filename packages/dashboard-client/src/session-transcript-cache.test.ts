import type { AuthoritativeSessionSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CachedSessionTranscript,
  decodeCachedSessionTranscript,
  InMemorySessionTranscriptCache,
} from './session-transcript-cache.js';
import { coverageWithPages } from './session-transcript-state.js';

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

function cachedWithCoverage(): CachedSessionTranscript {
  const coverage = coverageWithPages(
    [
      {
        start: 1,
        end: 2,
        hasOlder: true,
        nextBefore: 'before-zero',
        leadingContinuation: true,
        entryIds: ['first'],
        entryCount: 1,
        byteCount: 10,
      },
      {
        start: 2,
        end: 3,
        hasOlder: true,
        nextBefore: 'before-first',
        entryIds: ['middle'],
        entryCount: 1,
        byteCount: 20,
      },
      {
        start: 3,
        end: 4,
        hasOlder: true,
        nextBefore: 'before-middle',
        entryIds: ['last'],
        entryCount: 1,
        byteCount: 30,
      },
    ],
    7,
    'server-a',
    'epoch-a',
  );
  if (!coverage) throw new Error('Expected coverage');
  return { ...cached(), coverage };
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

  it('round-trips valid multipage coverage with its watermarks and continuations', () => {
    const value = cachedWithCoverage();
    expect(
      decodeCachedSessionTranscript(value, {
        expectedServerId: 'server-a',
        expectedSessionId: 'session-a',
      }),
    ).toEqual(value);
  });

  it.each([
    [
      'inconsistent aggregate totals',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        entryCount: (coverage?.entryCount ?? 0) + 1,
      }),
    ],
    [
      'inconsistent page ranges',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        pages: coverage?.pages.map((page, index) =>
          index === 1 ? { ...page, start: page.start + 1 } : page,
        ),
      }),
    ],
    [
      'inconsistent pagination',
      (coverage: CachedSessionTranscript['coverage']) => ({
        ...coverage,
        pages: coverage?.pages.map((page, index) =>
          index === 1
            ? { ...page, nextBefore: coverage?.pages[2]?.nextBefore }
            : page,
        ),
      }),
    ],
  ])('rejects %s in cached coverage', (_label, mutate) => {
    const value = cachedWithCoverage();
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
