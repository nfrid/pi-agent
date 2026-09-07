import { performance } from 'node:perf_hooks';
import {
  BoundedFeed,
  type FeedItem,
} from '../apps/dashboard-server/src/live-feed.js';

interface Snapshot {
  readonly ready: boolean;
}

interface Event {
  readonly index: number;
  readonly payload: string;
}

// Baseline before caching (1,000 events, 24KB payload): 1 subscriber 9.17ms,
// 8 subscribers 35.16ms. Rerun with the same environment for a comparison.
const eventCount = Number(process.env.FEED_BENCH_EVENTS ?? 1_000);
const payloadBytes = Number(process.env.FEED_BENCH_PAYLOAD_BYTES ?? 24_000);
const payload = 'x'.repeat(payloadBytes);
const bounds = {
  replayCount: 1,
  replayBytes: payloadBytes * 2,
  subscriberQueueCount: 4,
  subscriberQueueBytes: payloadBytes * 2,
  maxFrameBytes: payloadBytes * 2,
};

async function next<T, E>(
  iterator: AsyncGenerator<FeedItem<T, E>>,
): Promise<FeedItem<T, E>> {
  return (await iterator.next()).value as FeedItem<T, E>;
}

async function run(subscriberCount: number): Promise<number> {
  const feed = new BoundedFeed<Snapshot, Event>(
    `bench-${subscriberCount}`,
    bounds,
    `bench-generation-${subscriberCount}`,
  );
  const iterators = Array.from({ length: subscriberCount }, () =>
    feed.subscribe({ buildSnapshot: async () => ({ ready: true }) }),
  );
  for (const iterator of iterators) {
    await next(iterator);
    await next(iterator);
  }

  const started = performance.now();
  for (let index = 0; index < eventCount; index += 1) {
    const pending = iterators.map((iterator) => iterator.next());
    feed.publish({ index, payload });
    await Promise.all(pending);
  }
  const elapsed = performance.now() - started;

  for (const iterator of iterators) await iterator.return(undefined);
  return elapsed;
}

for (const subscriberCount of [1, 8]) {
  await run(subscriberCount);
  const elapsed = await run(subscriberCount);
  console.log(
    JSON.stringify({
      subscribers: subscriberCount,
      events: eventCount,
      payloadBytes,
      elapsedMs: Number(elapsed.toFixed(2)),
      publishesPerSecond: Math.round((eventCount / elapsed) * 1_000),
    }),
  );
}
