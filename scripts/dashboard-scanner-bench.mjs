import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  INDEX_MAX_LINE_BYTES,
  INDEX_SCAN_CHUNK_BYTES,
  scanSessionFile,
} from '../apps/dashboard-server/dist/session-index/scanner.js';

const samples = 7;
const warmups = 2;
const cases = [
  ['64KiB-crossing', INDEX_SCAN_CHUNK_BYTES + 1024],
  ['1MiB', 1024 * 1024],
  ['8MiB', 8 * 1024 * 1024],
  ['near-32MiB', INDEX_MAX_LINE_BYTES - 1024],
];

function fixture(targetBytes) {
  const header = `${JSON.stringify({ type: 'session', id: 'bench-session' })}\n`;
  const makeLine = (contentLength) =>
    `${JSON.stringify({
      type: 'message',
      id: 'bench-entry',
      message: { role: 'user', content: 'x'.repeat(contentLength) },
    })}\n`;
  let contentLength = Math.max(0, targetBytes - Buffer.byteLength(makeLine(0)));
  let line = makeLine(contentLength);
  while (Buffer.byteLength(line) < targetBytes) {
    contentLength += targetBytes - Buffer.byteLength(line);
    line = makeLine(contentLength);
  }
  return Buffer.from(header + line);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-scanner-bench-'));
try {
  for (const [name, targetBytes] of cases) {
    const file = path.join(directory, `${name}.jsonl`);
    await writeFile(file, fixture(targetBytes));
    for (let index = 0; index < warmups; index += 1)
      await scanSessionFile(file);
    const timings = [];
    for (let index = 0; index < samples; index += 1) {
      const started = performance.now();
      await scanSessionFile(file);
      timings.push(performance.now() - started);
    }
    console.log(
      JSON.stringify({
        node: process.version,
        case: name,
        bytes: (await stat(file)).size,
        warmups,
        samples,
        medianMs: Number(percentile(timings, 0.5).toFixed(2)),
        p95Ms: Number(percentile(timings, 0.95).toFixed(2)),
      }),
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
