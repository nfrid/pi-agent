export const ARTIFACT_ENTRY_TYPE = 'artifact:v1';
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_SEARCH_SCAN_BYTES = 256 * 1024;
export const SAFE_SOURCE_RE = /^[a-z0-9](?:[a-z0-9._:-]{0,63})$/;
export const TEXTUAL_CONTENT_CLASSES = [
  'web-page',
  'delegate-output',
  'tool-output',
  'text',
  'markdown',
  'json',
] as const;

export const PRODUCER_CLASSES = [
  'web',
  'delegate',
  'tool',
  'extension',
] as const;
export type ProducerClass = (typeof PRODUCER_CLASSES)[number];

export const CONTENT_CLASSES = [...TEXTUAL_CONTENT_CLASSES, 'binary'] as const;
export type ContentClass = (typeof CONTENT_CLASSES)[number];

export interface ArtifactMetadata {
  handle: string;
  sha256: string;
  size: number;
  producer: ProducerClass;
  contentClass: ContentClass;
  mediaType?: string;
  /** Sanitized, opaque producer-provided identifier; never a path or free text. */
  creationSource: string;
  encoding: 'utf-8' | 'binary';
  lineCount?: number;
  itemCount?: number;
  createdAt: string;
}

export interface Manifest {
  version: 1;
  sessionId: string;
  artifacts: Record<string, ArtifactMetadata>;
  revoked: string[];
  /** Read-only migration compatibility for manifests written before revocation terminology. */
  purged?: string[];
}

export interface RecoveryEntry {
  version: 1;
  kind: 'recovery';
  metadata: ArtifactMetadata;
  /** Base64 is a lossless transport copy for JSONL export/import/fork. */
  bytes: string;
}

export interface RevocationEntry {
  version: 1;
  kind: 'revoke';
  handle: string;
  revokedAt: string;
}

/** Existing append-only session records remain readable as revocations. */
export interface LegacyPurgeEntry {
  version: 1;
  kind: 'purge';
  handle: string;
  purgedAt: string;
}

export type TombstoneEntry = RevocationEntry | LegacyPurgeEntry;
export type ArtifactEntry = RecoveryEntry | TombstoneEntry;

export interface ResolvedArtifact {
  metadata: ArtifactMetadata;
  bytes: Buffer;
}

export interface PutArtifactInput {
  bytes: Uint8Array | string;
  producer: ProducerClass;
  contentClass: ContentClass;
  mediaType?: string;
  /** A short safe identifier such as `web.search` or `delegate.result`. */
  creationSource: string;
  /** Optional count for a producer-defined collection; JSON counts are derived and checked. */
  itemCount?: number;
}
