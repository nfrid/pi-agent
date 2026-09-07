// Build dashboard workspace dependencies first; run with Node, not Bun.
// Run: node scripts/dashboard-cache-bench.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { decodeCachedSessionTranscript } from '../packages/dashboard-client/dist/session-transcript-cache.js';

const samples = 7;
const iterations = 10;
console.log(
  JSON.stringify({ node: process.version, samples, iterations, warmups: 2 }),
);
for (const count of [1_000, 10_000]) {
  const order = Array.from({ length: count }, (_, index) => `entry-${index}`);
  const value = {
    version: 1,
    serverId: 'bench-server',
    sessionId: 'bench-session',
    savedAt: 1,
    acceptedSequence: 1,
    snapshot: {
      serverId: 'bench-server',
      cursor: 1,
      metadata: { id: 'bench-session', file: '', cwd: '/tmp', updatedAt: 1 },
      entries: [],
      history: { version: 1, start: 0, end: 0, hasOlder: false },
      entriesComplete: true,
      active: { messages: [], tools: [], delegates: [], truncated: false },
      completeThroughCursor: true,
    },
    projection: {
      sessionId: 'bench-session',
      order,
      items: Object.fromEntries(
        order.map((id) => [id, { kind: 'other', id, raw: null }]),
      ),
      lastCursor: 1,
      lastRuntimeSeq: 0,
      retiredEpochs: [],
    },
  };
  assert.ok(decodeCachedSessionTranscript(value));
  const elapsed = [];
  for (let sample = -2; sample < samples; sample += 1) {
    const before = performance.now();
    let accepted = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (decodeCachedSessionTranscript(value)) accepted += 1;
    }
    const duration = (performance.now() - before) / iterations;
    assert.equal(accepted, iterations);
    if (sample >= 0) elapsed.push(duration);
  }
  elapsed.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      count,
      medianDecodeMs: elapsed[Math.floor(samples / 2)],
      p95DecodeMs: elapsed[Math.ceil(samples * 0.95) - 1],
    }),
  );
}
