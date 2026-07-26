import { describe, expect, it } from 'vitest';
import { sanitizeOutput } from './format';
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
    for (let index = 0; index < 100_000; index++) output.push('x');
    const snapshot = output.snapshot();

    expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(1024);
    expect(snapshot.totalBytes).toBe(100_000);
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
  it('removes terminal escapes and unsafe control characters', () => {
    expect(sanitizeOutput('\u001b[31mred\u001b[0m\u0000\rnext')).toBe(
      'red\nnext',
    );
  });
});
