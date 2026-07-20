import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { recoverExpectedArtifact, scanArtifactEntries } from './scan-entries';
import {
  artifactRoot,
  blobPath,
  manifestPath,
  putBlob,
  readManifest,
  writeManifest,
} from './storage-io';
import { withArtifactRootLock, withManifestLock } from './storage-locking';
import {
  countLines,
  decodeText,
  derivedItemCount,
  HANDLE_RE,
  isTextual,
  sameMetadata,
  sanitizeCreationSource,
  sha256,
  validateInput,
  validateMetadata,
} from './storage-validation';
import {
  ARTIFACT_ENTRY_TYPE,
  type ArtifactMetadata,
  type Manifest,
  type PutArtifactInput,
  type RecoveryEntry,
  type ResolvedArtifact,
  type TombstoneEntry,
} from './types';

export {
  artifactRoot,
  clearArtifactRoot,
} from './storage-io';
export {
  ArtifactRootLockError,
  artifactLockPath,
  withArtifactRootLock,
} from './storage-locking';
export {
  sanitizeCreationSource,
  validateMetadata,
} from './storage-validation';

export interface PutArtifactOptions {
  root?: string;
  assertCurrent?: () => void;
  onPublished?: (metadata: ArtifactMetadata) => void;
}

export async function putArtifact(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  input: PutArtifactInput,
  options: PutArtifactOptions = {},
) {
  const root = options.root ?? artifactRoot();
  const assertCurrent = options.assertCurrent ?? (() => {});
  const publish = options.onPublished;
  const bytes = validateInput(input);
  const sessionId = ctx.sessionManager.getSessionId();
  const digest = sha256(bytes);
  const text = isTextual(input.contentClass) ? decodeText(bytes) : undefined;
  const derivedItems =
    text === undefined ? undefined : derivedItemCount(input.contentClass, text);
  const metadata = {
    handle: `art_${randomBytes(16).toString('base64url')}`,
    sha256: digest,
    size: bytes.length,
    producer: input.producer,
    contentClass: input.contentClass,
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    creationSource: sanitizeCreationSource(input.creationSource),
    encoding: text === undefined ? ('binary' as const) : ('utf-8' as const),
    ...(text === undefined ? {} : { lineCount: countLines(text) }),
    ...(input.itemCount === undefined && derivedItems === undefined
      ? {}
      : { itemCount: input.itemCount ?? derivedItems }),
    createdAt: new Date().toISOString(),
  };
  validateMetadata(metadata, bytes);
  return withArtifactRootLock(root, async () => {
    assertCurrent();
    await putBlob(root, bytes, digest);
    return withManifestLock(manifestPath(root, sessionId), async () => {
      const manifest = await readManifest(root, sessionId);
      assertCurrent();
      manifest.artifacts[metadata.handle] = metadata;
      manifest.revoked = manifest.revoked.filter(
        (value) => value !== metadata.handle,
      );
      await writeManifest(root, manifest);
      try {
        assertCurrent();
        // Publish the consumer reference first. If it fails, no recovery entry
        // can survive. If recovery append then fails, the reference is inert
        // and the caller may safely publish its bounded fallback.
        publish?.(metadata);
        assertCurrent();
        pi.appendEntry(ARTIFACT_ENTRY_TYPE, {
          version: 1,
          kind: 'recovery',
          metadata,
          bytes: bytes.toString('base64'),
        } satisfies RecoveryEntry);
      } catch (error) {
        delete manifest.artifacts[metadata.handle];
        await writeManifest(root, manifest);
        throw error;
      }
      return metadata;
    });
  });
}

export async function revokeArtifact(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  handle: string,
  root = artifactRoot(),
): Promise<boolean> {
  if (!HANDLE_RE.test(handle)) return false;
  const sessionId = ctx.sessionManager.getSessionId();
  return withArtifactRootLock(root, () =>
    withManifestLock(manifestPath(root, sessionId), async () => {
      const manifest = await readManifest(root, sessionId);
      const metadata = manifest.artifacts[handle];
      if (!metadata) return false;
      const priorRevoked = [...manifest.revoked];
      delete manifest.artifacts[handle];
      if (!manifest.revoked.includes(handle)) manifest.revoked.push(handle);
      await writeManifest(root, manifest);
      try {
        pi.appendEntry(ARTIFACT_ENTRY_TYPE, {
          version: 1,
          kind: 'revoke',
          handle,
          revokedAt: new Date().toISOString(),
        } satisfies TombstoneEntry);
      } catch (error) {
        manifest.artifacts[handle] = metadata;
        manifest.revoked = priorRevoked;
        await writeManifest(root, manifest);
        throw error;
      }
      return true;
    }),
  );
}

export async function restoreArtifacts(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  root = artifactRoot(),
): Promise<number> {
  return withArtifactRootLock(root, async () => {
    const sessionId = ctx.sessionManager.getSessionId();
    const { recovered, revoked } = scanArtifactEntries(
      ctx.sessionManager.getEntries(),
    );
    const manifest: Manifest = {
      version: 1,
      sessionId,
      artifacts: {},
      revoked: [...revoked],
    };
    for (const [handle, { entry, bytes }] of recovered) {
      await putBlob(root, bytes, entry.metadata.sha256);
      manifest.artifacts[handle] = entry.metadata;
    }
    await withManifestLock(manifestPath(root, sessionId), () =>
      writeManifest(root, manifest),
    );
    return Object.keys(manifest.artifacts).length;
  });
}

/** Resolve an untrusted consumer reference from append-only session entries.
 * Artifact wire parsing, tombstone ordering, integrity, and metadata parity stay
 * owned by this module rather than each consumer. */
export function recoverArtifactFromEntries(
  entries: Iterable<{
    type: string;
    customType?: string;
    data?: unknown;
  }>,
  expected: ArtifactMetadata,
): ResolvedArtifact | undefined {
  const recovery = recoverExpectedArtifact(
    scanArtifactEntries(entries),
    expected,
  );
  if (!recovery) return undefined;
  try {
    validateMetadata(expected, recovery.bytes);
    if (!sameMetadata(recovery.entry.metadata, expected)) return undefined;
    return { metadata: recovery.entry.metadata, bytes: recovery.bytes };
  } catch {
    return undefined;
  }
}

export async function resolveArtifact(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  handle: string,
  root = artifactRoot(),
) {
  if (!HANDLE_RE.test(handle)) return undefined;
  const manifest = await readManifest(root, ctx.sessionManager.getSessionId());
  const metadata = manifest.artifacts[handle];
  if (
    !metadata ||
    typeof metadata.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    return undefined;
  let bytes: Buffer;
  try {
    bytes = await readFile(blobPath(root, metadata.sha256));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  validateMetadata(metadata, bytes);
  return { metadata, bytes };
}
