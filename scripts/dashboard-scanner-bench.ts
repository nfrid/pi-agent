/* Run after building the server: node --experimental-strip-types scripts/dashboard-scanner-bench.ts */
const { performance } =
  require('node:perf_hooks') as typeof import('node:perf_hooks');
const { mkdtemp, rm, stat, writeFile } =
  require('node:fs/promises') as typeof import('node:fs/promises');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');

const samples = Number(process.env.SCANNER_BENCH_SAMPLES ?? 7);
const warmups = Number(process.env.SCANNER_BENCH_WARMUPS ?? 2);

function fixture(targetBytes: number): Buffer {
  const header = `${JSON.stringify({ type: 'session', id: 'bench-session' })}\n`;
  const makeLine = (contentLength: number) =>
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

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

async function main(): Promise<void> {
  const { INDEX_MAX_LINE_BYTES, INDEX_SCAN_CHUNK_BYTES, scanSessionFile } =
    await import('../apps/dashboard-server/dist/session-index/scanner.js');
  const cases = [
    ['64KiB-crossing', INDEX_SCAN_CHUNK_BYTES + 1024],
    ['1MiB', 1024 * 1024],
    ['8MiB', 8 * 1024 * 1024],
    ['near-32MiB', INDEX_MAX_LINE_BYTES - 1024],
  ] as const;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-scanner-bench-'));
  try {
    for (const [name, targetBytes] of cases) {
      const file = path.join(directory, `${name}.jsonl`);
      await writeFile(file, fixture(targetBytes));
      for (let index = 0; index < warmups; index += 1)
        await scanSessionFile(file);
      const timings: number[] = [];
      for (let index = 0; index < samples; index += 1) {
        const started = performance.now();
        await scanSessionFile(file);
        timings.push(performance.now() - started);
      }
      console.log(
        `${name}\tbytes=${(await stat(file)).size.toLocaleString()}\tmedian=${percentile(timings, 0.5).toFixed(2)}ms\tp95=${percentile(timings, 0.95).toFixed(2)}ms`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void main();
