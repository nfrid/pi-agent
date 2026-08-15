import { describe, expect, it } from 'vitest';
import {
  BoundedFeed,
  decodeFeedId,
  type FeedItem,
  FeedOverflowError,
} from './live-feed.js';
import {
  MAX_SESSION_FEEDS,
  SessionFeed,
  SessionFeedRegistry,
} from './live-feeds.js';

const bounds = {
  replayCount: 8,
  replayBytes: 10_000,
  subscriberQueueCount: 8,
  subscriberQueueBytes: 10_000,
};

type Snapshot = { value: number };
type Event = { value: number; key?: string };

async function next<T, E>(
  iterator: AsyncGenerator<FeedItem<T, E>>,
): Promise<FeedItem<T, E>> {
  return (await iterator.next()).value as FeedItem<T, E>;
}

function cursorAt(id: string, sequence: number, generation?: string): string {
  const decoded = decodeFeedId(id);
  if (!decoded) throw new Error('Expected a valid test cursor.');
  return Buffer.from(
    JSON.stringify({
      generation: generation ?? decoded.generation,
      feed: decoded.feed,
      sequence,
    }),
    'utf8',
  ).toString('base64url');
}

describe('BoundedFeed', () => {
  it('keeps an atomic snapshot/live handoff and explicit caught-up marker', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'shell',
      bounds,
      'generation',
    );
    let release!: () => void;
    const building = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured = -1;
    const iterator = feed.subscribe({
      buildSnapshot: async (sequence) => {
        captured = sequence;
        await building;
        return { value: sequence };
      },
    });
    const pending = iterator.next();
    await Promise.resolve();
    expect(captured).toBe(0);
    feed.publish({ value: 1 });
    expect(feed.metrics()).toMatchObject({
      queuedCount: 1,
      queuedBytes: expect.any(Number),
    });
    expect(feed.metrics().queuedBytes).toBeGreaterThan(0);
    release();
    expect((await pending).value).toMatchObject({
      kind: 'snapshot',
      sequence: 0,
    });
    expect(await next(iterator)).toMatchObject({ kind: 'event', sequence: 1 });
    expect(await next(iterator)).toMatchObject({
      kind: 'caught-up',
      sequence: 1,
    });
    feed.publish({ value: 2 });
    expect(await next(iterator)).toMatchObject({ kind: 'event', sequence: 2 });
    await pending;
    await iterator.return(undefined);
    expect(feed.metrics().subscribers).toBe(0);
  });

  it('replays only same-generation retained opaque IDs and rebases expired IDs', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'session-a',
      {
        ...bounds,
        replayCount: 2,
      },
      'generation',
    );
    const first = feed.publish({ value: 1 });
    const second = feed.publish({ value: 2 });
    expect(first.id).not.toContain('sequence');
    const replay = feed.subscribe({
      lastEventId: first.id,
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(replay)).toMatchObject({ kind: 'event', sequence: 2 });
    expect(await next(replay)).toMatchObject({ kind: 'caught-up' });
    await replay.return(undefined);

    const foreign = feed.subscribe({
      lastEventId: cursorAt(first.id, 1, 'other-generation'),
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(foreign)).toMatchObject({ kind: 'snapshot' });
    await foreign.return(undefined);
    expect(feed.metrics().snapshotFallbacks.foreign).toBe(1);
    const future = feed.subscribe({
      lastEventId: cursorAt(second.id, 3),
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(future)).toMatchObject({ kind: 'snapshot' });
    await future.return(undefined);
    expect(feed.metrics().snapshotFallbacks.future).toBe(1);

    const invalid = feed.subscribe({
      lastEventId: 'not-a-cursor',
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(invalid)).toMatchObject({ kind: 'snapshot' });
    await invalid.return(undefined);
    expect(feed.metrics().snapshotFallbacks.invalid).toBe(1);

    feed.publish({ value: 3 });
    const expired = feed.subscribe({
      lastEventId: cursorAt(second.id, 0),
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(expired)).toMatchObject({ kind: 'snapshot' });
    await expired.return(undefined);
    expect(feed.metrics().snapshotFallbacks.expired).toBe(1);
  });

  it('closes active subscribers deterministically during feed shutdown', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'shell',
      bounds,
      'generation',
    );
    const iterator = feed.subscribe({
      buildSnapshot: async () => ({ value: 0 }),
    });
    await next(iterator);
    await next(iterator);
    const pending = iterator.next();
    feed.close();
    await expect(pending).rejects.toThrow('Feed closed.');
    expect(feed.metrics().subscribers).toBe(0);
  });

  it('aborts a subscription while its authoritative snapshot is pending', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'shell',
      bounds,
      'generation',
    );
    const controller = new AbortController();
    let release!: () => void;
    const building = new Promise<void>((resolve) => {
      release = resolve;
    });
    const iterator = feed.subscribe({
      signal: controller.signal,
      buildSnapshot: async () => {
        await building;
        return { value: 0 };
      },
    });
    const pending = iterator.next();
    await Promise.resolve();
    expect(feed.metrics().subscribers).toBe(1);
    controller.abort();
    release();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(feed.metrics().subscribers).toBe(0);
  });

  it('keeps deferred keyed records ordered and cleans aborted subscribers', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'shell',
      bounds,
      'generation',
    );
    let release!: () => void;
    const building = new Promise<void>((resolve) => (release = resolve));
    const iterator = feed.subscribe({
      buildSnapshot: async () => {
        await building;
        return { value: 0 };
      },
    });
    const pending = iterator.next();
    await Promise.resolve();
    feed.publish({ value: 1, key: 'summary' }, { key: 'summary' });
    feed.publish({ value: 2, key: 'summary' }, { key: 'summary' });
    release();
    expect((await pending).value).toMatchObject({ kind: 'snapshot' });
    expect(await next(iterator)).toMatchObject({
      kind: 'event',
      sequence: 1,
      event: { value: 1 },
    });
    expect(await next(iterator)).toMatchObject({
      kind: 'event',
      sequence: 2,
      event: { value: 2 },
    });
    expect(await next(iterator)).toMatchObject({ kind: 'caught-up' });
    await iterator.return(undefined);
    const controller = new AbortController();
    const aborted = feed.subscribe({
      signal: controller.signal,
      buildSnapshot: async () => ({ value: 0 }),
    });
    const waiting = aborted.next();
    controller.abort();
    await waiting;
    await aborted.return(undefined);
    expect(feed.metrics().subscribers).toBe(0);
  });

  it('rebases before a coalesced record while preserving observed cursors', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'shell',
      bounds,
      'generation',
    );
    const first = feed.publish(
      { value: 1, key: 'summary' },
      { key: 'summary' },
    );
    const second = feed.publish({ value: 2 });
    feed.publish({ value: 3, key: 'summary' }, { key: 'summary' });

    const retained = (
      feed as unknown as {
        records: readonly { sequence: number }[];
      }
    ).records;
    expect(retained.map((record) => record.sequence)).toEqual([2, 3]);

    const before = feed.subscribe({
      lastEventId: cursorAt(first.id, 0),
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(before)).toMatchObject({ kind: 'snapshot', sequence: 3 });
    await before.return(undefined);

    const atCoalesced = feed.subscribe({
      lastEventId: first.id,
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(atCoalesced)).toMatchObject({
      kind: 'event',
      sequence: 2,
    });
    expect(await next(atCoalesced)).toMatchObject({
      kind: 'event',
      sequence: 3,
    });
    expect(await next(atCoalesced)).toMatchObject({ kind: 'caught-up' });
    await atCoalesced.return(undefined);

    const afterSecond = feed.subscribe({
      lastEventId: second.id,
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(afterSecond)).toMatchObject({
      kind: 'event',
      sequence: 3,
    });
    expect(await next(afterSecond)).toMatchObject({ kind: 'caught-up' });
    await afterSecond.return(undefined);
  });

  it('keeps coalescing gaps bounded under a large replacement burst', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'shell',
      { ...bounds, replayCount: 8 },
      'generation',
    );
    feed.publish({ value: 0 });
    const first = feed.publish(
      { value: 1, key: 'summary' },
      { key: 'summary' },
    );
    for (let value = 2; value <= 10_001; value += 1)
      feed.publish({ value, key: 'summary' }, { key: 'summary' });

    const metrics = feed.metrics();
    expect(metrics.replayCount).toBeLessThanOrEqual(8);
    expect(metrics.replayBytes).toBeLessThanOrEqual(bounds.replayBytes);
    expect(metrics.coalesced).toBe(10_000);
    expect(metrics.unavailableThroughSequence).toBe(10_000);
    expect(
      (feed as unknown as { unavailableSequences?: unknown })
        .unavailableSequences,
    ).toBeUndefined();

    const resumed = feed.subscribe({
      lastEventId: first.id,
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    const rebased = await next(resumed);
    expect(rebased).toMatchObject({
      kind: 'snapshot',
      sequence: 10_002,
    });
    expect(feed.metrics().snapshotFallbacks.unavailable).toBe(1);
    expect(await next(resumed)).toMatchObject({ kind: 'caught-up' });
    await resumed.return(undefined);

    feed.publish({ value: 10_002 });
    const postRebase = feed.subscribe({
      lastEventId: rebased.id,
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(postRebase)).toMatchObject({
      kind: 'event',
      sequence: 10_003,
    });
    expect(await next(postRebase)).toMatchObject({ kind: 'caught-up' });
    expect(feed.metrics().snapshotFallbacks.unavailable).toBe(1);
    await postRebase.return(undefined);
  });

  it('reports replay fallback when the replay itself exceeds queue bounds', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'shell',
      { ...bounds, subscriberQueueCount: 2 },
      'generation',
    );
    const first = feed.publish({ value: 1 });
    feed.publish({ value: 2 });
    const resumed = feed.subscribe({
      lastEventId: cursorAt(first.id, 0),
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(resumed)).toMatchObject({
      kind: 'snapshot',
      sequence: 2,
    });
    expect(feed.metrics().snapshotFallbacks['too-large']).toBe(1);
    await resumed.return(undefined);
  });

  it('terminates connected subscribers on one oversized event and rebases on resume', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'session-a',
      { ...bounds, maxFrameBytes: 64 },
      'generation',
    );
    const first = feed.publish({ value: 1 });
    const iterator = feed.subscribe({
      lastEventId: first.id,
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(iterator)).toMatchObject({ kind: 'caught-up' });
    const waiting = iterator.next();
    expect(() =>
      feed.publish({ value: 2, key: `oversized-${'x'.repeat(100)}` }),
    ).toThrow();
    await expect(waiting).rejects.toBeInstanceOf(FeedOverflowError);

    const resumed = feed.subscribe({
      lastEventId: first.id,
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    const rebased = await next(resumed);
    expect(rebased).toMatchObject({ kind: 'snapshot', sequence: 2 });
    await resumed.return(undefined);

    const settled = feed.subscribe({
      lastEventId: rebased.id,
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(settled)).toMatchObject({
      kind: 'caught-up',
      sequence: 2,
    });
    await settled.return(undefined);
  });

  it('propagates queued overflow after a consumer pauses at a prior yield', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'shell',
      {
        ...bounds,
        subscriberQueueCount: 3,
      },
      'generation',
    );
    const iterator = feed.subscribe({
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(iterator)).toMatchObject({ kind: 'snapshot' });
    expect(await next(iterator)).toMatchObject({ kind: 'caught-up' });

    feed.publish({ value: 1 });
    feed.publish({ value: 2 });
    feed.publish({ value: 3 });
    feed.publish({ value: 4 });
    await expect(iterator.next()).rejects.toBeInstanceOf(FeedOverflowError);
    expect(feed.metrics().subscribers).toBe(0);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('bounds subscriber queues and reports retryable overflow without affecting other subscribers', async () => {
    const feed = new BoundedFeed<Snapshot, Event>(
      'shell',
      {
        ...bounds,
        subscriberQueueCount: 2,
        subscriberQueueBytes: 200,
      },
      'generation',
    );
    let release!: () => void;
    const building = new Promise<void>((resolve) => (release = resolve));
    const overflowing = feed.subscribe({
      buildSnapshot: async () => {
        await building;
        return { value: 0 };
      },
    });
    const pending = overflowing.next();
    await Promise.resolve();
    feed.publish({ value: 1 });
    feed.publish({ value: 2 });
    release();
    await expect(pending).rejects.toBeInstanceOf(FeedOverflowError);
    expect(feed.metrics().subscribers).toBe(0);
  });
});

describe('session feed identifiers', () => {
  it('hashes maximum-length ASCII and unicode IDs into fixed-length feed keys', () => {
    for (const sessionId of ['a'.repeat(256), '😀'.repeat(256)]) {
      const feed = new SessionFeed(sessionId, bounds);
      expect(new SessionFeed(sessionId, bounds).feed).toBe(feed.feed);
      const decoded = decodeFeedId(feed.currentId);
      expect(decoded?.feed).toMatch(/^session-[0-9a-f]{64}$/u);
      expect(decoded?.feed).toHaveLength(72);
      expect(decoded?.feed).not.toContain(sessionId);

      feed.publishEvent({
        type: 'session.compacted',
        sessionId,
        entry: {},
      });
      expect(feed.sessionId).toBe(sessionId);
    }
  });
});

describe('feed registry routing', () => {
  it('creates session feeds lazily and isolates session A from B', async () => {
    const registry = new SessionFeedRegistry(bounds);
    const a = registry.get('a');
    const b = registry.get('b');
    a.publishEvent({ type: 'session.compacted', sessionId: 'a', entry: {} });
    const iterator = b.subscribe({
      buildSnapshot: async () =>
        ({
          metadata: { id: 'b' },
          entries: [],
          entriesComplete: true,
          serverId: 'server',
          cursor: 0,
          active: {
            messages: [],
            tools: [],
            interactions: [],
            delegateRuns: [],
          },
        }) as never,
    });
    expect(await next(iterator)).toMatchObject({ kind: 'snapshot' });
    expect(await next(iterator)).toMatchObject({ kind: 'caught-up' });
    await iterator.return(undefined);
    expect(a.metrics().replayCount).toBe(1);
    expect(b.metrics().replayCount).toBe(0);
    registry.close();
  });

  it('bounds arbitrary feed growth without evicting active or subscribed feeds', async () => {
    const registry = new SessionFeedRegistry(bounds);
    registry.setActive('active', true);
    const subscribed = registry.get('subscribed');
    const iterator = subscribed.subscribe({
      buildSnapshot: async () => ({}) as never,
    });
    await next(iterator);
    await next(iterator);

    for (let index = 0; index < MAX_SESSION_FEEDS - 2; index += 1)
      registry.get(`inactive-${index}`);
    expect(registry.metrics()).toHaveLength(MAX_SESSION_FEEDS);

    registry.get('overflow');
    expect(registry.metrics()).toHaveLength(MAX_SESSION_FEEDS);
    expect(registry.get('active').active).toBe(true);
    expect(registry.get('subscribed').metrics().subscribers).toBe(1);

    await iterator.return(undefined);
    registry.close();
  });

  it('creates and pins feeds for active runtimes before their first event', () => {
    const registry = new SessionFeedRegistry(bounds);
    const now = Date.now();
    registry.setActive('active', true);
    expect(registry.metrics()).toEqual([
      expect.objectContaining({ sessionId: 'active', active: true }),
    ]);
    expect(registry.sweep(now + 10_000_000, 1)).toBe(0);

    registry.setActive('active', false);
    expect(registry.sweep(now + 10_000_001, 1)).toBe(1);
    expect(registry.metrics()).toEqual([]);
    registry.close();
  });
});
