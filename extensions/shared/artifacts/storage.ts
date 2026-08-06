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
  ARTIFACT_VIEW_ENTRY_TYPE,
  type ArtifactMetadata,
  type ArtifactViewRegistryEntry,
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
const SAFE_VIEW_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

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

export interface ArtifactViewPublication {
  /** The full delegate.result artifact this selected artifact belongs to. */
  source: ArtifactMetadata;
  name: string;
  /** Canonical schema-authorized path used to derive the selected bytes. */
  path: string;
}

export interface PutArtifactOptions {
  root?: string;
  /** Throws if the session moved on while the write was in flight. */
  assertCurrent?: () => void;
  onPublished?: (metadata: ArtifactMetadata) => void;
  /** Publishes a checked delegate view mapping with this artifact. */
  delegateView?: ArtifactViewPublication;
}

/**
 * Store bytes and hand back a handle the agent can retrieve them by.
 *
 * The artifact is written to disk and mirrored into the session as a recovery
 * entry, so the handle keeps working after a fork, export, or GC sweep.
 */
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
  if (options.delegateView)
    await verifyDelegateViewPublication(
      root,
      sessionId,
      options.delegateView,
      metadata,
      bytes,
    );
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
  if (options.delegateView) {
    assertCurrent();
    appendDelegateViewRegistry(pi, options.delegateView, metadata);
  }
  return metadata;
}

function decodeViewPath(pathValue: string): string[] | undefined {
  if (!pathValue || pathValue === '/' || !pathValue.startsWith('/'))
    return undefined;
  const raw = pathValue.slice(1).split('/');
  if (raw.some((segment) => !segment)) return undefined;
  const segments = raw.map((segment) => {
    if (segment === '.' || segment === '..' || /^\d+$/.test(segment))
      return undefined;
    if (/~(?![01])/.test(segment)) return undefined;
    const decoded = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      !decoded ||
      decoded.includes('\u0000') ||
      decoded === '__proto__' ||
      decoded === 'constructor' ||
      decoded === 'prototype'
    )
      return undefined;
    return decoded;
  });
  return segments.every((segment): segment is string => segment !== undefined)
    ? segments
    : undefined;
}

function isCanonicalViewPath(pathValue: string): boolean {
  const segments = decodeViewPath(pathValue);
  if (!segments) return false;
  const encoded = `/${segments
    .map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`;
  return encoded === pathValue;
}

function selectViewPath(
  value: unknown,
  segments: string[],
): { present: boolean; value?: unknown } {
  if (segments.length === 0) return { present: true, value };
  const [segment, ...rest] = segments;
  if (segment === '*') {
    if (!Array.isArray(value)) return { present: false };
    return {
      present: true,
      value: value.map((item) => {
        const selected = selectViewPath(item, rest);
        return selected.present ? selected.value : undefined;
      }),
    };
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.hasOwn(value, segment)
  )
    return { present: false };
  return selectViewPath((value as Record<string, unknown>)[segment], rest);
}

function appendDelegateViewRegistry(
  pi: AppendOnly,
  publication: ArtifactViewPublication,
  metadata: ArtifactMetadata,
): void {
  const { source, name, path: pathValue } = publication;
  if (!HANDLE_RE.test(source.handle) || !HANDLE_RE.test(metadata.handle))
    throw new Error('Invalid artifact view handle');
  if (source.handle === metadata.handle)
    throw new Error(
      'A named artifact view cannot reuse its full artifact handle',
    );
  if (
    source.producer !== 'delegate' ||
    source.contentClass !== 'delegate-output' ||
    source.encoding !== 'utf-8' ||
    source.creationSource !== 'delegate.result' ||
    metadata.producer !== 'delegate' ||
    metadata.contentClass !== 'delegate-output' ||
    metadata.encoding !== 'utf-8' ||
    metadata.creationSource !== 'delegate.view'
  )
    throw new Error('Invalid delegate artifact view metadata');
  if (!SAFE_VIEW_NAME_RE.test(name) || !isCanonicalViewPath(pathValue))
    throw new Error('Invalid artifact view name or path');
  pi.appendEntry(ARTIFACT_VIEW_ENTRY_TYPE, {
    version: 1,
    kind: 'view',
    source,
    view: name,
    path: pathValue,
    metadata,
  } satisfies ArtifactViewRegistryEntry);
}

async function verifyDelegateViewPublication(
  root: string,
  sessionId: string,
  publication: ArtifactViewPublication,
  metadata: ArtifactMetadata,
  bytes: Buffer,
): Promise<void> {
  const { source, path: pathValue } = publication;
  if (
    !HANDLE_RE.test(source.handle) ||
    !HANDLE_RE.test(metadata.handle) ||
    source.handle === metadata.handle ||
    source.producer !== 'delegate' ||
    source.contentClass !== 'delegate-output' ||
    source.encoding !== 'utf-8' ||
    source.creationSource !== 'delegate.result' ||
    metadata.producer !== 'delegate' ||
    metadata.contentClass !== 'delegate-output' ||
    metadata.encoding !== 'utf-8' ||
    metadata.creationSource !== 'delegate.view' ||
    !SAFE_VIEW_NAME_RE.test(publication.name) ||
    !isCanonicalViewPath(pathValue)
  )
    throw new Error('Invalid delegate artifact view publication');

  const sourcePaths = artifactPaths(root, sessionId, source.handle);
  let sourceMetadata: unknown;
  let sourceBytes: Buffer;
  try {
    sourceMetadata = JSON.parse(await readFile(sourcePaths.metadata, 'utf8'));
    sourceBytes = await readFile(sourcePaths.bytes);
  } catch {
    throw new Error('Delegate artifact view source is unavailable');
  }
  validateMetadata(sourceMetadata, sourceBytes);
  if (!sameMetadata(sourceMetadata, source))
    throw new Error('Delegate artifact view source metadata does not match');
  let sourceValue: unknown;
  try {
    sourceValue = JSON.parse(sourceBytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Delegate artifact view source is not JSON');
  }
  const selected = selectViewPath(sourceValue, decodeViewPath(pathValue) ?? []);
  if (!selected.present)
    throw new Error('Delegate artifact view path is not present');
  const expected = Buffer.from(JSON.stringify(selected.value), 'utf8');
  if (!expected.equals(bytes))
    throw new Error(
      'Delegate artifact view bytes do not match its source path',
    );
}

function viewRegistryEntries(
  entries: Iterable<{ type: string; customType?: string; data?: unknown }>,
): ArtifactViewRegistryEntry[] {
  const result: ArtifactViewRegistryEntry[] = [];
  for (const entry of entries) {
    if (
      entry.type !== 'custom' ||
      entry.customType !== ARTIFACT_VIEW_ENTRY_TYPE
    )
      continue;
    const data = entry.data as Partial<ArtifactViewRegistryEntry> | undefined;
    if (
      data?.version === 1 &&
      data.kind === 'view' &&
      typeof data.view === 'string' &&
      typeof data.path === 'string' &&
      isCanonicalViewPath(data.path) &&
      data.source &&
      data.metadata
    )
      result.push(data as ArtifactViewRegistryEntry);
  }
  return result;
}

/** Resolve a named view only through the current session's persisted registry. */
export async function resolveArtifactView(
  ctx: SessionContext,
  sourceHandle: string,
  view: string,
  root = artifactRoot(),
): Promise<ResolvedArtifact | undefined> {
  if (
    !HANDLE_RE.test(sourceHandle) ||
    !view ||
    view.length > 64 ||
    !/^[A-Za-z][A-Za-z0-9_-]*$/.test(view)
  )
    return undefined;
  const entries = viewRegistryEntries(ctx.sessionManager.getEntries());
  const entry = [...entries]
    .reverse()
    .find(
      (candidate) =>
        candidate.source.handle === sourceHandle && candidate.view === view,
    );
  if (!entry) return undefined;
  if (
    entry.source.producer !== 'delegate' ||
    entry.source.contentClass !== 'delegate-output' ||
    entry.source.encoding !== 'utf-8' ||
    entry.source.creationSource !== 'delegate.result' ||
    entry.metadata.producer !== 'delegate' ||
    entry.metadata.contentClass !== 'delegate-output' ||
    entry.metadata.encoding !== 'utf-8' ||
    entry.metadata.creationSource !== 'delegate.view' ||
    entry.metadata.handle === entry.source.handle ||
    !isCanonicalViewPath(entry.path)
  )
    return undefined;
  const source = await resolveArtifact(ctx, sourceHandle, root);
  if (!source || !sameMetadata(source.metadata, entry.source)) return undefined;
  let sourceValue: unknown;
  try {
    sourceValue = JSON.parse(source.bytes.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
  const selected = selectViewPath(
    sourceValue,
    decodeViewPath(entry.path) ?? [],
  );
  if (!selected.present) return undefined;
  const expectedBytes = Buffer.from(JSON.stringify(selected.value), 'utf8');
  const resolved = await resolveArtifact(ctx, entry.metadata.handle, root);
  if (!resolved || !sameMetadata(resolved.metadata, entry.metadata))
    return undefined;
  if (!expectedBytes.equals(resolved.bytes)) return undefined;
  return resolved;
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
