import { randomBytes } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { ensureDir } from '../fs/atomic';
import {
  ARTIFACT_ENTRY_TYPE,
  type ArtifactMetadata,
  type PutArtifactInput,
  type RecoveryEntry,
  type ResolvedArtifact,
} from './types';
import {
  countLines,
  decodeText,
  derivedItemCount,
  HANDLE_RE,
  isTextual,
  sameMetadata,
  sha256,
  validateInput,
  validateMetadata,
  validRecoveryBytes,
} from './validation';

const ROOT = 'artifacts/v1';

type SessionContext = Pick<ExtensionContext, 'sessionManager'>;
type AppendOnly = Pick<ExtensionAPI, 'appendEntry'>;

export function artifactRoot(agentDir = getAgentDir()): string {
  return path.join(agentDir, ROOT);
}

/**
 * The on-disk directory for one session's artifacts.
 *
 * Session IDs are hashed rather than used directly: they are host-provided and
 * need not be safe path segments.
 */
export function sessionDirectory(root: string, sessionId: string): string {
  return path.join(root, sha256(sessionId));
}

function artifactPaths(root: string, sessionId: string, handle: string) {
  const directory = sessionDirectory(root, sessionId);
  return {
    directory,
    metadata: path.join(directory, `${handle}.json`),
    bytes: path.join(directory, `${handle}.bin`),
  };
}

export async function clearArtifactRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

async function writeArtifact(
  root: string,
  sessionId: string,
  metadata: ArtifactMetadata,
  bytes: Buffer,
): Promise<void> {
  const target = artifactPaths(root, sessionId, metadata.handle);
  await ensureDir(target.directory);
  // Handles are freshly generated per put, so a file name is never reused and
  // there is no reader that could observe a half-written artifact.
  await writeFile(target.bytes, bytes, { mode: 0o600 });
  await writeFile(target.metadata, `${JSON.stringify(metadata)}\n`, {
    mode: 0o600,
  });
}

/**
 * Store bytes and hand back a handle the agent can retrieve them by.
 *
 * The artifact is written to disk and mirrored into the session as a recovery
 * entry, so the handle keeps working after a fork, export, or GC sweep.
 */
export interface PutArtifactOptions {
  root?: string;
  assertCurrent?: () => void;
  onPublished?: (metadata: ArtifactMetadata) => void;
}

export async function putArtifact(
  pi: AppendOnly,
  ctx: SessionContext,
  input: PutArtifactInput,
  options: PutArtifactOptions = {},
): Promise<ArtifactMetadata> {
  const root = options.root ?? artifactRoot();
  const assertCurrent = options.assertCurrent ?? (() => {});
  const bytes = validateInput(input);
  const sessionId = ctx.sessionManager.getSessionId();
  const text = isTextual(input.contentClass) ? decodeText(bytes) : undefined;
  const derivedItems =
    text === undefined ? undefined : derivedItemCount(input.contentClass, text);
  const metadata: ArtifactMetadata = {
    handle: `art_${randomBytes(16).toString('base64url')}`,
    sha256: sha256(bytes),
    size: bytes.length,
    producer: input.producer,
    contentClass: input.contentClass,
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    creationSource: input.creationSource.trim().toLowerCase(),
    encoding: text === undefined ? 'binary' : 'utf-8',
    ...(text === undefined ? {} : { lineCount: countLines(text) }),
    ...(input.itemCount === undefined && derivedItems === undefined
      ? {}
      : { itemCount: input.itemCount ?? derivedItems }),
    createdAt: new Date().toISOString(),
  };
  validateMetadata(metadata, bytes);

  assertCurrent();
  await writeArtifact(root, sessionId, metadata, bytes);
  assertCurrent();
  // The consumer reference is published first: if that fails there is no
  // dangling recovery entry, and the caller may fall back to inline content.
  options.onPublished?.(metadata);
  assertCurrent();
  pi.appendEntry(ARTIFACT_ENTRY_TYPE, {
    version: 1,
    kind: 'recovery',
    metadata,
    bytes: bytes.toString('base64'),
  } satisfies RecoveryEntry);
  return metadata;
}

export async function resolveArtifact(
  ctx: SessionContext,
  handle: string,
  root = artifactRoot(),
): Promise<ResolvedArtifact | undefined> {
  if (!HANDLE_RE.test(handle)) return undefined;
  const target = artifactPaths(root, ctx.sessionManager.getSessionId(), handle);
  let metadata: unknown;
  let bytes: Buffer;
  try {
    metadata = JSON.parse(await readFile(target.metadata, 'utf8'));
    bytes = await readFile(target.bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  validateMetadata(metadata, bytes);
  return { metadata, bytes };
}

/** Every recovery entry on the session branch, latest write per handle. */
function scanRecoveryEntries(
  entries: Iterable<{ type: string; customType?: string; data?: unknown }>,
): Map<string, ResolvedArtifact> {
  const recovered = new Map<string, ResolvedArtifact>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== ARTIFACT_ENTRY_TYPE)
      continue;
    const data = entry.data as RecoveryEntry | undefined;
    if (data?.version !== 1 || data.kind !== 'recovery') continue;
    const bytes = validRecoveryBytes(data);
    if (bytes)
      recovered.set(data.metadata.handle, { metadata: data.metadata, bytes });
  }
  return recovered;
}

/**
 * Rebuild this session's artifact files from its valid recovery entries and
 * remove stale sidecars that are no longer authorized by the current branch.
 *
 * Runs on session start and on tree changes, so a resumed, forked, or imported
 * session finds its handles live even though nothing was written to disk here.
 */
async function removeStaleSidecars(
  root: string,
  sessionId: string,
  recovered: Map<string, ResolvedArtifact>,
): Promise<void> {
  const directory = sessionDirectory(root, sessionId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const staleHandles = new Set<string>();
  for (const name of names) {
    const match = /^(art_[A-Za-z0-9_-]{22})\.(?:json|bin)$/.exec(name);
    if (match && !recovered.has(match[1])) staleHandles.add(match[1]);
  }
  await Promise.all(
    [...staleHandles].map(async (handle) => {
      const paths = artifactPaths(root, sessionId, handle);
      await Promise.all([
        rm(paths.metadata, { force: true }),
        rm(paths.bytes, { force: true }),
      ]);
    }),
  );
}

export async function restoreArtifacts(
  ctx: SessionContext,
  root = artifactRoot(),
): Promise<number> {
  const sessionId = ctx.sessionManager.getSessionId();
  const recovered = scanRecoveryEntries(ctx.sessionManager.getEntries());
  await removeStaleSidecars(root, sessionId, recovered);
  for (const artifact of recovered.values())
    await writeArtifact(root, sessionId, artifact.metadata, artifact.bytes);
  return recovered.size;
}

/**
 * Resolve an untrusted consumer reference straight from session entries.
 *
 * Consumers hold metadata they read out of their own session records; this is
 * the one place that decides whether such a reference still describes real,
 * matching bytes.
 */
export function recoverArtifactFromEntries(
  entries: Iterable<{ type: string; customType?: string; data?: unknown }>,
  expected: ArtifactMetadata,
): ResolvedArtifact | undefined {
  if (!HANDLE_RE.test(expected.handle ?? '')) return undefined;
  const recovered = scanRecoveryEntries(entries).get(expected.handle);
  if (!recovered || !sameMetadata(recovered.metadata, expected))
    return undefined;
  return recovered;
}
