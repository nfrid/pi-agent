import { createHash } from 'node:crypto';
import {
  type ArtifactMetadata,
  CONTENT_CLASSES,
  MAX_ARTIFACT_BYTES,
  PRODUCER_CLASSES,
  type PutArtifactInput,
  type RecoveryEntry,
  SAFE_SOURCE_RE,
  TEXTUAL_CONTENT_CLASSES,
  type TombstoneEntry,
} from './types';

export const HANDLE_RE = /^art_[A-Za-z0-9_-]{22}$/;
const MAX_RECOVERY_BASE64_CHARS = 4 * Math.ceil(MAX_ARTIFACT_BYTES / 3);

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isTextual(contentClass: string): boolean {
  return (TEXTUAL_CONTENT_CLASSES as readonly string[]).includes(contentClass);
}

/** Source IDs are deliberately identifiers, not paths, URLs, labels, or snippets. */
export function sanitizeCreationSource(source: string): string {
  if (typeof source !== 'string' || source.length > 128) {
    throw new Error('creationSource must be a short safe identifier');
  }
  const sanitized = source.trim().toLowerCase();
  if (
    !SAFE_SOURCE_RE.test(sanitized) ||
    sanitized.includes('://') ||
    sanitized.includes('/') ||
    sanitized.includes('\\') ||
    sanitized.includes('@') ||
    sanitized.includes('%')
  ) {
    throw new Error('creationSource must be a sanitized safe identifier');
  }
  return sanitized;
}

export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Textual artifacts must contain valid UTF-8');
  }
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

export function derivedItemCount(
  contentClass: string,
  text: string,
): number | undefined {
  if (contentClass !== 'json') return undefined;
  const value = JSON.parse(text) as unknown;
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).length;
  }
  return undefined;
}

function validateItemCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_ARTIFACT_BYTES
  ) {
    throw new Error('itemCount must be a non-negative safe integer');
  }
  return value;
}

export function validateMetadata(
  metadata: unknown,
  bytes: Uint8Array,
): asserts metadata is import('./types').ArtifactMetadata {
  if (metadata === null || typeof metadata !== 'object')
    throw new Error('Invalid artifact metadata');
  const value = metadata as Record<string, unknown>;
  if (
    typeof value.handle !== 'string' ||
    !/^art_[A-Za-z0-9_-]{22}$/.test(value.handle) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > MAX_ARTIFACT_BYTES ||
    typeof value.producer !== 'string' ||
    !(PRODUCER_CLASSES as readonly string[]).includes(value.producer) ||
    typeof value.contentClass !== 'string' ||
    !(CONTENT_CLASSES as readonly string[]).includes(value.contentClass) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.createdAt !== new Date(value.createdAt).toISOString()
  ) {
    throw new Error('Invalid artifact metadata');
  }
  const source = sanitizeCreationSource(value.creationSource as string);
  if (source !== value.creationSource)
    throw new Error('Invalid creationSource');
  const textual = isTextual(value.contentClass);
  if (value.encoding !== (textual ? 'utf-8' : 'binary'))
    throw new Error('Invalid artifact encoding');
  const actualText = textual ? decodeText(bytes) : undefined;
  const expectedLines =
    actualText === undefined ? undefined : countLines(actualText);
  if (value.lineCount !== expectedLines)
    throw new Error('Invalid artifact lineCount');
  const suppliedItems = validateItemCount(value.itemCount);
  const expectedItems =
    actualText === undefined
      ? undefined
      : derivedItemCount(value.contentClass, actualText);
  if (
    expectedItems !== undefined &&
    suppliedItems !== undefined &&
    suppliedItems !== expectedItems
  )
    throw new Error('Invalid artifact itemCount');
  if (
    value.mediaType !== undefined &&
    (typeof value.mediaType !== 'string' || value.mediaType.length > 256)
  )
    throw new Error('Invalid artifact mediaType');
  if (bytes.length !== value.size || sha256(bytes) !== value.sha256)
    throw new Error('Artifact metadata does not match bytes');
}

export function validateInput(input: PutArtifactInput): Buffer {
  if (!(PRODUCER_CLASSES as readonly string[]).includes(input.producer)) {
    throw new Error(
      `Disallowed artifact producer class: ${String(input.producer)}`,
    );
  }
  if (!(CONTENT_CLASSES as readonly string[]).includes(input.contentClass)) {
    throw new Error(
      `Disallowed artifact content class: ${String(input.contentClass)}`,
    );
  }
  sanitizeCreationSource(input.creationSource);
  const bytes = Buffer.from(input.bytes);
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} byte ceiling`);
  }
  if (input.mediaType && input.mediaType.length > 256) {
    throw new Error('Artifact mediaType exceeds 256 characters');
  }
  if (isTextual(input.contentClass)) decodeText(bytes);
  const itemCount = validateItemCount(input.itemCount);
  if (input.contentClass === 'json') {
    const expected = derivedItemCount(input.contentClass, decodeText(bytes));
    if (
      itemCount !== undefined &&
      expected !== undefined &&
      itemCount !== expected
    )
      throw new Error('itemCount must match JSON top-level item count');
  }
  return bytes;
}

export function validTombstone(
  data: RecoveryEntry | TombstoneEntry | undefined,
): data is TombstoneEntry {
  if (data?.version !== 1 || (data.kind !== 'revoke' && data.kind !== 'purge'))
    return false;
  const timestamp = data.kind === 'revoke' ? data.revokedAt : data.purgedAt;
  return (
    typeof data.handle === 'string' &&
    HANDLE_RE.test(data.handle) &&
    typeof timestamp === 'string' &&
    Number.isFinite(Date.parse(timestamp))
  );
}

function validBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    )
      return false;
  }
  return true;
}

export function validRecoveryBytes(data: RecoveryEntry): Buffer | undefined {
  if (
    typeof data.bytes !== 'string' ||
    data.bytes.length > MAX_RECOVERY_BASE64_CHARS
  )
    return undefined;
  const padding = data.bytes.endsWith('==')
    ? 2
    : data.bytes.endsWith('=')
      ? 1
      : 0;
  const decodedBytes = (data.bytes.length / 4) * 3 - padding;
  if (decodedBytes > MAX_ARTIFACT_BYTES || !validBase64(data.bytes))
    return undefined;
  const bytes = Buffer.from(data.bytes, 'base64');
  try {
    validateMetadata(data.metadata, bytes);
    return bytes;
  } catch {
    return undefined;
  }
}

export function sameMetadata(
  left: ArtifactMetadata,
  right: ArtifactMetadata,
): boolean {
  return (
    left.handle === right.handle &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.producer === right.producer &&
    left.contentClass === right.contentClass &&
    left.mediaType === right.mediaType &&
    left.creationSource === right.creationSource &&
    left.encoding === right.encoding &&
    left.lineCount === right.lineCount &&
    left.itemCount === right.itemCount &&
    left.createdAt === right.createdAt
  );
}
