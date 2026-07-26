import { sha256 } from '../hash';
import {
  type ArtifactMetadata,
  CONTENT_CLASSES,
  MAX_ARTIFACT_BYTES,
  PRODUCER_CLASSES,
  type PutArtifactInput,
  type RecoveryEntry,
  SAFE_SOURCE_RE,
  TEXTUAL_CONTENT_CLASSES,
} from './types';

export const HANDLE_RE = /^art_[A-Za-z0-9_-]{22}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_RECOVERY_BASE64_CHARS = 4 * Math.ceil(MAX_ARTIFACT_BYTES / 3);

export { sha256 };

export function isTextual(contentClass: string): boolean {
  return (TEXTUAL_CONTENT_CLASSES as readonly string[]).includes(contentClass);
}

/** Source IDs are deliberately identifiers, not paths, URLs, labels, or snippets. */
export function sanitizeCreationSource(source: string): string {
  if (typeof source !== 'string' || source.length > 128) {
    throw new Error('creationSource must be a short safe identifier');
  }
  const sanitized = source.trim().toLowerCase();
  if (!SAFE_SOURCE_RE.test(sanitized)) {
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

/**
 * Assert that metadata describes exactly these bytes.
 *
 * Metadata travels through the session JSONL, which can be exported, edited,
 * and re-imported, so it is re-derived and compared rather than trusted.
 */
export function validateMetadata(
  metadata: unknown,
  bytes: Uint8Array,
): asserts metadata is ArtifactMetadata {
  if (metadata === null || typeof metadata !== 'object')
    throw new Error('Invalid artifact metadata');
  const value = metadata as Record<string, unknown>;
  if (
    typeof value.handle !== 'string' ||
    !HANDLE_RE.test(value.handle) ||
    typeof value.sha256 !== 'string' ||
    !SHA256_RE.test(value.sha256) ||
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
  if (
    sanitizeCreationSource(value.creationSource as string) !==
    value.creationSource
  )
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

/**
 * Whether two metadata records describe the same artifact in every respect.
 *
 * A consumer holds its own copy of the metadata, read back from its own session
 * record; a divergence in any field means the two records disagree about what
 * the handle is, which is reason enough to refuse it.
 */
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

/** Decode a recovery entry's transport copy, or reject it as unusable. */
export function validRecoveryBytes(data: RecoveryEntry): Buffer | undefined {
  if (
    typeof data.bytes !== 'string' ||
    data.bytes.length > MAX_RECOVERY_BASE64_CHARS
  )
    return undefined;
  const bytes = Buffer.from(data.bytes, 'base64');
  try {
    validateMetadata(data.metadata, bytes);
    return bytes;
  } catch {
    return undefined;
  }
}
