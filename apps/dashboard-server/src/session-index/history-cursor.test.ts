import { describe, expect, it } from 'vitest';
import {
  decodeHistoryCursor,
  decodeHistoryCursorV2,
  encodeHistoryCursor,
  encodeHistoryCursorV2,
  type HistoryCursor,
  type HistoryCursorV2,
  isLegacyHistoryCursor,
} from './history-cursor.js';

const hash = 'a'.repeat(64);

const legacyCursor: HistoryCursor = {
  version: 1,
  sessionId: 'session-id',
  file: '/sessions/session.jsonl',
  dev: 1,
  ino: 2,
  size: 3,
  prefixHash: hash,
  before: 4,
  leafId: 'leaf-id',
};

const indexedCursor: HistoryCursorV2 = {
  version: 2,
  sessionId: 'session-id',
  file: '/sessions/session.jsonl',
  dev: 1,
  ino: 2,
  indexedSize: 3,
  selectedOrdinal: 4,
  selectedByteOffset: 5,
  prefixHash: hash,
  fileHash: 'b'.repeat(64),
  leafId: 'leaf-id',
};

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('history cursor codecs', () => {
  it('round trips the legacy and indexed wire formats', () => {
    const legacy = encodeHistoryCursor(legacyCursor);
    const indexed = encodeHistoryCursorV2(indexedCursor);

    expect(legacy).toBe(encoded(legacyCursor));
    expect(indexed).toBe(encoded(indexedCursor));
    expect(decodeHistoryCursor(legacy)).toEqual(legacyCursor);
    expect(decodeHistoryCursorV2(indexed)).toEqual(indexedCursor);
  });

  it('rejects malformed inputs with the existing error', () => {
    expect(() => decodeHistoryCursor('not-a-cursor')).toThrow(
      'Invalid history cursor.',
    );
    expect(() =>
      decodeHistoryCursor(encoded({ ...legacyCursor, before: 0 })),
    ).toThrow('Invalid history cursor.');
    expect(() =>
      decodeHistoryCursorV2(encoded({ ...indexedCursor, extra: true })),
    ).toThrow('Invalid history cursor.');
    expect(() => decodeHistoryCursorV2(`${encoded(indexedCursor)}=`)).toThrow(
      'Invalid history cursor.',
    );
  });

  it('detects v1 cursors while routing v2 cursors to the indexed reader', () => {
    expect(isLegacyHistoryCursor(encodeHistoryCursor(legacyCursor))).toBe(true);
    expect(isLegacyHistoryCursor(encodeHistoryCursorV2(indexedCursor))).toBe(
      false,
    );
    expect(() => isLegacyHistoryCursor('not-a-cursor')).toThrow(
      'Invalid history cursor.',
    );
  });
});
