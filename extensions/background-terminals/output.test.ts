import { describe, expect, it } from 'vitest';
import { peekOutput, sanitizeOutput } from './format';
import type { BackgroundSnapshot } from './manager';
import { OutputTail } from './output';

describe('OutputTail', () => {
  it('retains a bounded tail and tracks omitted bytes', () => {
    const output = new OutputTail(6);
    output.push('abc');
    output.push('def');
    output.push('ghi');

    expect(output.snapshot()).toEqual({
      text: 'defghi',
      totalBytes: 9,
      droppedBytes: 3,
    });
  });

  it('handles highly fragmented output within the byte bound', () => {
    const output = new OutputTail(1024);
    for (let index = 0; index < 2_000; index++) output.push('x');
    const snapshot = output.snapshot();

    expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(1024);
    expect(snapshot.totalBytes).toBe(2_000);
  });

  it('trims oversized chunks on a UTF-8 boundary', () => {
    const output = new OutputTail(5);
    output.push('a🙂b🙂c');
    const snapshot = output.snapshot();

    expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(5);
    expect(snapshot.text).toBe('🙂c');
    expect(snapshot.totalBytes).toBe(Buffer.byteLength('a🙂b🙂c'));
    expect(snapshot.droppedBytes + Buffer.byteLength(snapshot.text)).toBe(
      snapshot.totalBytes,
    );
  });
});

describe('sanitizeOutput', () => {
  it('returns structured tails with the same sanitization and omission bounds as peek text', () => {
    const output = peekOutput(
      {
        stdout: {
          text: 'old\n\u001b[31mnew\u001b[0m\nlast',
          totalBytes: 100,
          droppedBytes: 12,
        },
        stderr: { text: '', totalBytes: 0, droppedBytes: 0 },
      } as BackgroundSnapshot,
      2,
    );
    expect(output.stdout).toEqual({
      text: 'new\nlast',
      omitted: true,
      totalBytes: 100,
      droppedBytes: 12,
    });
    expect(output.stderr).toEqual({
      text: '',
      omitted: false,
      totalBytes: 0,
      droppedBytes: 0,
    });
  });
  it('removes terminal escapes and unsafe control characters', () => {
    expect(sanitizeOutput('\u001b[31mred\u001b[0m\u0000\rnext')).toBe(
      'red\nnext',
    );
  });
});
