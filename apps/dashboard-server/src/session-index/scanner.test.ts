import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INDEX_MAX_LINE_BYTES,
  INDEX_SCAN_CHUNK_BYTES,
  scanSessionFile,
} from './scanner.js';

async function scanBytes(bytes: Buffer, proofOffsets: number[] = []) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'pi-dashboard-scanner-'),
  );
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, bytes);
  return scanSessionFile(file, proofOffsets);
}

function prefixHash(bytes: Buffer, end: number): string {
  return createHash('sha256').update(bytes.subarray(0, end)).digest('hex');
}

describe('scanSessionFile', () => {
  it('preserves split UTF-8, CRLF, malformed, partial, and proof boundaries', async () => {
    const header = Buffer.from(
      `${JSON.stringify({ type: 'session', id: 'session-id' })}\n`,
    );
    const linePrefix = Buffer.from(
      '{"type":"message","id":"split","message":{"role":"user","content":"',
    );
    const paddingLength =
      (INDEX_SCAN_CHUNK_BYTES -
        ((header.length + linePrefix.length) % INDEX_SCAN_CHUNK_BYTES) -
        1 +
        INDEX_SCAN_CHUNK_BYTES) %
      INDEX_SCAN_CHUNK_BYTES;
    const splitLine = Buffer.concat([
      linePrefix,
      Buffer.from('x'.repeat(paddingLength)),
      Buffer.from('€ split"}}\r\n'),
    ]);
    const malformed = Buffer.concat([
      Buffer.from('{"type":"message","id":"bad","message":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n'),
    ]);
    const partial = Buffer.from('{"type":"message","id":"partial"');
    const bytes = Buffer.concat([header, splitLine, malformed, partial]);
    const proofOffsets = [
      0,
      header.length,
      header.length + splitLine.length,
      bytes.length,
    ];
    const result = await scanBytes(bytes, proofOffsets);

    expect(result.descriptors.map(({ id }) => id)).toEqual([
      'session-id',
      'split',
    ]);
    expect(result.descriptors[1]).toMatchObject({
      start: header.length,
      end: header.length + splitLine.length,
    });
    expect(result.prefixHashes.get(header.length)).toBe(
      prefixHash(bytes, header.length),
    );
    expect(result.prefixHashes.get(header.length + splitLine.length)).toBe(
      prefixHash(bytes, header.length + splitLine.length),
    );
    expect(result.prefixHashes.get(bytes.length)).toBe(
      prefixHash(bytes, bytes.length),
    );
    expect(result.fileHash).toBe(prefixHash(bytes, bytes.length));
  });

  it('accepts a completed line at the existing bound when its newline is next chunk', async () => {
    const header = Buffer.from(
      `${JSON.stringify({ type: 'session', id: 'bound-session' })}\n`,
    );
    const bytes = Buffer.concat([
      header,
      Buffer.alloc(INDEX_MAX_LINE_BYTES, 0x20),
      Buffer.from('\n'),
    ]);

    await expect(scanBytes(bytes)).resolves.toMatchObject({
      descriptors: [expect.objectContaining({ id: 'bound-session' })],
    });
  });

  it('scans a line spanning many chunks without changing its descriptor', async () => {
    const header = `${JSON.stringify({ type: 'session', id: 'large-session' })}\n`;
    const content = 'a'.repeat(1024 * 1024);
    const line = `${JSON.stringify({
      type: 'message',
      id: 'large-entry',
      message: { role: 'user', content },
    })}\n`;
    const result = await scanBytes(Buffer.from(header + line));

    expect(result.descriptors).toHaveLength(2);
    expect(result.descriptors[1]).toMatchObject({
      id: 'large-entry',
      start: Buffer.byteLength(header),
      end: Buffer.byteLength(header + line),
    });
  });
});
