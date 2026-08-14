import { describe, expect, it } from 'vitest';
import {
  BoundedFeed,
  decodeFeedId,
  type FeedItem,
  FeedOverflowError,
} from './live-feed.js';
import { SessionFeedRegistry } from './live-feeds.js';

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
    const future = feed.subscribe({
      lastEventId: cursorAt(second.id, 3),
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(future)).toMatchObject({ kind: 'snapshot' });
    await future.return(undefined);

    feed.publish({ value: 3 });
    const expired = feed.subscribe({
      lastEventId: cursorAt(second.id, 0),
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(expired)).toMatchObject({ kind: 'snapshot' });
    await expired.return(undefined);
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

  it('rebases cursors before and at a coalesced record, while preserving replay order', async () => {
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
      kind: 'snapshot',
      sequence: 3,
    });
    await atCoalesced.return(undefined);

    const afterSecond = feed.subscribe({
      lastEventId: second.id,
      buildSnapshot: async (sequence) => ({ value: sequence }),
    });
    expect(await next(afterSecond)).toMatchObject({
      kind: 'event',
      sequence: 3,
      event: { value: 3 },
    });
    await afterSecond.return(undefined);
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
