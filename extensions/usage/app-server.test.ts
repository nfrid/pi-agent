import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryViaCodexAppServer } from './app-server';

let fixture = '';
let originalPath: string | undefined;

beforeEach(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'usage-app-server-'));
  originalPath = process.env.PATH;
  const executable = path.join(fixture, 'codex');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const readline = require('node:readline');
process.stderr.write('diagnostic\\n'.repeat(12000));
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (typeof message.id !== 'number') return;
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  } else if (!process.env.FAKE_CODEX_HANG) {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { rateLimits: { primary: { usedPercent: 12 } } },
    }) + '\\n');
  }
});
`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${fixture}${path.delimiter}${originalPath ?? ''}`;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.FAKE_CODEX_HANG;
  rmSync(fixture, { recursive: true, force: true });
});

describe('Codex app-server lifecycle', () => {
  it('drains bounded stderr while processing RPC output', async () => {
    const report = await queryViaCodexAppServer(new AbortController().signal);
    expect(report.snapshots[0]?.primary?.usedPercent).toBe(12);
  });

  it('kills and rejects pending work on caller cancellation', async () => {
    process.env.FAKE_CODEX_HANG = '1';
    const controller = new AbortController();
    const query = queryViaCodexAppServer(controller.signal);
    setTimeout(() => controller.abort(new Error('session shutdown')), 50);
    await expect(query).rejects.toThrow('session shutdown');
  });
});
