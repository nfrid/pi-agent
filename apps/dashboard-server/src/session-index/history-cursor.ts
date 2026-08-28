import { isRecord } from '@pi-dashboard/protocol';

export interface HistoryCursor {
  version: 1;
  sessionId: string;
  file: string;
  dev: number;
  ino: number;
  size: number;
  prefixHash: string;
  before: number;
  /** Active branch leaf when the page was branch-filtered. */
  leafId?: string;
}

/** Browser-visible history cursors are opaque, but their proof is strict. */
export interface HistoryCursorV2 {
  version: 2;
  sessionId: string;
  file: string;
  dev: number;
  ino: number;
  indexedSize: number;
  selectedOrdinal: number;
  selectedByteOffset: number;
  prefixHash: string;
  fileHash: string;
  leafId?: string;
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeHistoryCursor(value: string): HistoryCursor {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > 4096
  )
    throw new Error('Invalid history cursor.');
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<HistoryCursor>;
    if (
      decoded.version !== 1 ||
      typeof decoded.sessionId !== 'string' ||
      typeof decoded.file !== 'string' ||
      typeof decoded.dev !== 'number' ||
      !Number.isSafeInteger(decoded.dev) ||
      typeof decoded.ino !== 'number' ||
      !Number.isSafeInteger(decoded.ino) ||
      typeof decoded.size !== 'number' ||
      !Number.isSafeInteger(decoded.size) ||
      typeof decoded.prefixHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(decoded.prefixHash) ||
      typeof decoded.before !== 'number' ||
      !Number.isSafeInteger(decoded.before) ||
      decoded.before <= 0 ||
      (decoded.leafId !== undefined &&
        (typeof decoded.leafId !== 'string' || decoded.leafId.length === 0))
    )
      throw new Error();
    return decoded as HistoryCursor;
  } catch {
    throw new Error('Invalid history cursor.');
  }
}

export function encodeHistoryCursorV2(cursor: HistoryCursorV2): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeHistoryCursorV2(value: string): HistoryCursorV2 {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length > 4096 ||
    Buffer.from(value, 'base64url').toString('base64url') !== value
  )
    throw new Error('Invalid history cursor.');
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as unknown;
    if (!isRecord(decoded) || Array.isArray(decoded)) throw new Error();
    const allowed = new Set([
      'version',
      'sessionId',
      'file',
      'dev',
      'ino',
      'indexedSize',
      'selectedOrdinal',
      'selectedByteOffset',
      'prefixHash',
      'fileHash',
      'leafId',
    ]);
    if (Object.keys(decoded).some((key) => !allowed.has(key)))
      throw new Error();
    const nonnegativeSafeInt = (key: string): boolean =>
      typeof decoded[key] === 'number' &&
      Number.isSafeInteger(decoded[key]) &&
      decoded[key] >= 0;
    if (
      decoded.version !== 2 ||
      typeof decoded.sessionId !== 'string' ||
      decoded.sessionId.length === 0 ||
      typeof decoded.file !== 'string' ||
      decoded.file.length === 0 ||
      !nonnegativeSafeInt('dev') ||
      !nonnegativeSafeInt('ino') ||
      !nonnegativeSafeInt('indexedSize') ||
      !nonnegativeSafeInt('selectedOrdinal') ||
      !nonnegativeSafeInt('selectedByteOffset') ||
      typeof decoded.prefixHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(decoded.prefixHash) ||
      typeof decoded.fileHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(decoded.fileHash) ||
      (decoded.leafId !== undefined &&
        (typeof decoded.leafId !== 'string' || decoded.leafId.length === 0))
    )
      throw new Error();
    return decoded as unknown as HistoryCursorV2;
  } catch {
    throw new Error('Invalid history cursor.');
  }
}

export function isLegacyHistoryCursor(value: string): boolean {
  try {
    decodeHistoryCursor(value);
    return true;
  } catch {
    decodeHistoryCursorV2(value);
    return false;
  }
}
