// Build @pi-dashboard/server and its workspace dependencies first.
// Run: node --expose-gc scripts/dashboard-history-bench.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionIndex } from '../apps/dashboard-server/dist/session-index.js';

const samples = 7;
console.log(JSON.stringify({ node: process.version, samples, warmups: 2 }));
for (const count of [1_000, 10_000]) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'dashboard-history-bench-'),
  );
  const index = new SessionIndex(directory);
  try {
    const entries = [
      { type: 'session', version: 3, id: 'bench-session', cwd: directory },
      ...Array.from({ length: count }, (_, position) => ({
        type: 'message',
        id: `entry-${position}`,
        parentId: position === 0 ? null : `entry-${position - 1}`,
        message: {
          role: position % 2 === 0 ? 'user' : 'assistant',
          content: [
            { type: 'text', text: `Message ${position} ${'x'.repeat(512)}` },
          ],
        },
      })),
    ];
    const source = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    await writeFile(path.join(directory, 'session.jsonl'), source);
    await index.rebuild();
    const session = index.list()[0];
    assert.ok(session);
    const first = await index.readEntries(session.id);
    assert.ok(first.history.nextBefore);
    const operations = [
      ['unchanged-rebuild', () => index.rebuild()],
      ['latest-page', () => index.readEntries(session.id)],
      [
        'older-page',
        () => index.readEntries(session.id, first.history.nextBefore),
      ],
      [
        'selected-branch-page',
        () => index.readEntries(session.id, undefined, `entry-${count - 1}`),
      ],
    ];
    for (const [operation, run] of operations) {
      for (let warmup = 0; warmup < 2; warmup += 1) await run();
      const elapsed = [];
      const cpu = [];
      const readBytes = [];
      for (let sample = 0; sample < samples; sample += 1) {
        index.resetHistoryReadBytes();
        const beforeCpu = process.cpuUsage();
        const before = performance.now();
        const result = await run();
        elapsed.push(performance.now() - before);
        const used = process.cpuUsage(beforeCpu);
        cpu.push((used.user + used.system) / 1_000);
        readBytes.push(index.historyReadBytes);
        if (result) assert.ok(result.entries.length > 0);
      }
      elapsed.sort((a, b) => a - b);
      cpu.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          count,
          sourceBytes: Buffer.byteLength(source),
          operation,
          medianMs: elapsed[Math.floor(samples / 2)],
          p95Ms: elapsed[Math.ceil(samples * 0.95) - 1],
          medianCpuMs: cpu[Math.floor(samples / 2)],
          maxHistoryReadBytes: Math.max(...readBytes),
        }),
      );
    }
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
}
