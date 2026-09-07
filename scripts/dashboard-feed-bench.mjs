// Build the server first; run: node scripts/dashboard-feed-bench.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BoundedFeed } from '../apps/dashboard-server/dist/live-feed.js';

const eventCount = 1_000;
const payloadBytes = 24_000;
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

async function run(subscriberCount) {
  const feed = new BoundedFeed(
    `bench-${subscriberCount}`,
    bounds,
    'bench-generation',
  );
  const iterators = Array.from({ length: subscriberCount }, () =>
    feed.subscribe({ buildSnapshot: async () => ({ ready: true }) }),
  );
  try {
    for (const iterator of iterators) {
      await iterator.next();
      await iterator.next();
    }
    let received;
    const started = performance.now();
    for (let index = 0; index < eventCount; index += 1) {
      const pending = iterators.map((iterator) => iterator.next());
      feed.publish({ index, payload });
      received = await Promise.all(pending);
    }
    const elapsed = performance.now() - started;
    assert.ok(
      received.every(
        (item) => !item.done && item.value.sequence === eventCount,
      ),
    );
    assert.equal(feed.metrics().queuedBytes, 0);
    return elapsed;
  } finally {
    for (const iterator of iterators) await iterator.return(undefined);
  }
}

for (const subscribers of [1, 8]) {
  for (let index = 0; index < warmupCount; index += 1) await run(subscribers);
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1)
    samples.push(await run(subscribers));
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      node: process.version,
      subscribers,
      events: eventCount,
      payloadBytes,
      warmups: warmupCount,
      samples: sampleCount,
      medianMs: samples[Math.floor(sampleCount / 2)],
      p95Ms: samples[Math.ceil(sampleCount * 0.95) - 1],
    }),
  );
}
