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

const eventCount = Number(process.env.FEED_BENCH_EVENTS ?? 1_000);
const payloadBytes = Number(process.env.FEED_BENCH_PAYLOAD_BYTES ?? 24_000);
const payload = 'x'.repeat(payloadBytes);
const warmupCount = 2;
const sampleCount = 7;
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

function percentile(samples: readonly number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(samples.length * fraction));
  return [...samples].sort((a, b) => a - b)[rank - 1] as number;
}

for (const subscriberCount of [1, 8]) {
  for (let index = 0; index < warmupCount; index += 1)
    await run(subscriberCount);
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1)
    samples.push(await run(subscriberCount));
  console.log(
    JSON.stringify({
      node: process.version,
      subscribers: subscriberCount,
      events: eventCount,
      payloadBytes,
      warmups: warmupCount,
      samples: sampleCount,
      medianMs: Number(percentile(samples, 0.5).toFixed(2)),
      p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    }),
  );
}
