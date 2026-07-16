import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  ARTIFACT_ENTRY_TYPE,
  CONTENT_CLASSES,
  MAX_ARTIFACT_BYTES,
  type Manifest,
  PRODUCER_CLASSES,
  type PutArtifactInput,
  type RecoveryEntry,
  SAFE_SOURCE_RE,
  TEXTUAL_CONTENT_CLASSES,
  type TombstoneEntry,
} from './types';

const ROOT = 'artifacts/v1';
const HANDLE_RE = /^art_[A-Za-z0-9_-]{22}$/;
const ROOT_LOCK_NAME = '.artifact-root.lock';
const ROOT_LOCK_MAX_WAIT_MS = 3_000;
const ROOT_LOCK_MIN_BACKOFF_MS = 10;
const ROOT_LOCK_MAX_BACKOFF_MS = 200;
const artifactRootQueues = new Map<string, Promise<void>>();
const manifestQueues = new Map<string, Promise<void>>();

interface RootLockOwner {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
}

export class ArtifactRootLockError extends Error {
  readonly code = 'ARTIFACT_ROOT_LOCK_UNAVAILABLE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactRootLockError';
  }
}

export function artifactLockPath(root: string): string {
  return path.join(path.resolve(root), ROOT_LOCK_NAME);
}

function validOwner(value: unknown): value is RootLockOwner {
  if (value === null || typeof value !== 'object') return false;
  const owner = value as Record<string, unknown>;
  return (
    owner.version === 1 &&
    typeof owner.token === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(owner.token) &&
    typeof owner.pid === 'number' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.createdAt === 'number' &&
    Number.isSafeInteger(owner.createdAt) &&
    owner.createdAt > 0
  );
}

async function readLockOwner(
  lockPath: string,
): Promise<RootLockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
    if (!validOwner(parsed))
      throw new Error('Artifact root lock owner metadata is invalid');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // Malformed, empty, or inaccessible metadata is ambiguous and must block.
    throw new Error('Artifact root lock owner metadata is ambiguous', {
      cause: error,
    });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is not signalable by this user.
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    return true;
  }
}

async function recoverAbandonedLock(
  lockPath: string,
  owner: RootLockOwner | undefined,
): Promise<boolean> {
  if (!owner || processIsAlive(owner.pid)) return false;
  try {
    const current = await readLockOwner(lockPath);
    if (
      !current ||
      current.token !== owner.token ||
      current.pid !== owner.pid ||
      current.createdAt !== owner.createdAt
    )
      return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    // ENOENT means another contender won the race. All other errors, including
    // malformed metadata, are ambiguous and remain blocking.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function acquireFilesystemLock(
  root: string,
  maxWaitMs: number,
): Promise<() => Promise<void>> {
  await ensureDir(root);
  const lockPath = artifactLockPath(root);
  const owner: RootLockOwner = {
    version: 1,
    token: randomBytes(24).toString('base64url'),
    pid: process.pid,
    createdAt: Date.now(),
  };
  const temporary = `${lockPath}.${process.pid}.${owner.token}.tmp`;
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  let backoff = ROOT_LOCK_MIN_BACKOFF_MS;
  for (;;) {
    try {
      const descriptor = await open(temporary, 'wx', 0o600);
      try {
        await descriptor.writeFile(`${JSON.stringify(owner)}\n`);
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
      await chmod(temporary, 0o600);
      try {
        // The fixed path becomes visible only after complete, synced metadata
        // exists. link() is atomic and never overwrites another holder.
        await link(temporary, lockPath);
      } finally {
        // Only this acquisition's temporary file is ever cleaned up.
        await unlink(temporary).catch(() => undefined);
      }
      return async () => {
        try {
          const current = await readLockOwner(lockPath);
          if (
            !current ||
            current.token !== owner.token ||
            current.pid !== owner.pid ||
            current.createdAt !== owner.createdAt
          )
            return;
          await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
        }
      };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existingOwner: RootLockOwner | undefined;
      try {
        existingOwner = await readLockOwner(lockPath);
        await recoverAbandonedLock(lockPath, existingOwner);
      } catch {
        // Ambiguous owner state remains blocking until the bounded deadline.
      }
      if (Date.now() >= deadline)
        throw new ArtifactRootLockError(
          `Artifact root lock unavailable after ${maxWaitMs}ms`,
        );
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(backoff, Math.max(1, deadline - Date.now())),
        ),
      );
      backoff = Math.min(ROOT_LOCK_MAX_BACKOFF_MS, backoff * 2);
    }
  }
}

/**
 * Serializes CAS publication/recovery/revocation with GC for one artifact root.
 * Lock order is always root queue, filesystem lock, then per-session manifest lock.
 */
export async function withArtifactRootLock<T>(
  root: string,
  work: () => Promise<T>,
  options: { maxWaitMs?: number } = {},
): Promise<T> {
  const key = path.resolve(root);
  const previous = artifactRootQueues.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  artifactRootQueues.set(key, current);
  await previous.catch(() => undefined);
  let releaseFilesystem: (() => Promise<void>) | undefined;
  try {
    try {
      releaseFilesystem = await acquireFilesystemLock(
        key,
        options.maxWaitMs ?? ROOT_LOCK_MAX_WAIT_MS,
      );
    } catch (error) {
      if (error instanceof ArtifactRootLockError) throw error;
      throw new ArtifactRootLockError('Artifact root lock acquisition failed', {
        cause: error,
      });
    }
    return await work();
  } finally {
    if (releaseFilesystem) await releaseFilesystem();
    releaseQueue();
    if (artifactRootQueues.get(key) === current) artifactRootQueues.delete(key);
  }
}

async function withManifestLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = manifestQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  manifestQueues.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (manifestQueues.get(key) === current) manifestQueues.delete(key);
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sessionKey(sessionId: string): string {
  return sha256(sessionId);
}

export function artifactRoot(agentDir = getAgentDir()): string {
  return path.join(agentDir, ROOT);
}

function blobPath(root: string, digest: string): string {
  return path.join(root, 'blobs', digest.slice(0, 2), digest.slice(2));
}

function manifestPath(root: string, sessionId: string): string {
  return path.join(root, 'manifests', `${sessionKey(sessionId)}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function atomicReplace(
  file: string,
  bytes: Uint8Array | string,
): Promise<void> {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const descriptor = await open(temporary, 'wx', 0o600);
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  await chmod(file, 0o600);
}

async function putBlob(
  root: string,
  bytes: Uint8Array,
  digest: string,
): Promise<void> {
  const target = blobPath(root, digest);
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    try {
      // link is an atomic, no-clobber publication even with concurrent writers.
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  await chmod(target, 0o600);
  let stored = await readFile(target);
  if (stored.length !== bytes.length || sha256(stored) !== digest) {
    // A damaged CAS blob must not make a fresh snapshot fail closed. Repair only
    // after verifying the published bytes are actually wrong; a concurrent writer
    // may win the no-clobber replacement and will be verified below.
    await unlink(target).catch(() => undefined);
    try {
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    stored = await readFile(target);
  }
  if (stored.length !== bytes.length || sha256(stored) !== digest) {
    throw new Error(`Artifact CAS integrity failure for ${digest}`);
  }
}

async function readManifest(
  root: string,
  sessionId: string,
): Promise<Manifest> {
  try {
    const parsed = JSON.parse(
      await readFile(manifestPath(root, sessionId), 'utf8'),
    ) as Manifest;
    if (parsed.version !== 1 || parsed.sessionId !== sessionId)
      throw new Error();
    parsed.revoked ??= parsed.purged ?? [];
    delete parsed.purged;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, sessionId, artifacts: {}, revoked: [] };
    }
    throw error;
  }
}

async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  await atomicReplace(
    manifestPath(root, manifest.sessionId),
    `${JSON.stringify(manifest)}\n`,
  );
}

function isTextual(contentClass: string): boolean {
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

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Textual artifacts must contain valid UTF-8');
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

function derivedItemCount(
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

function validateInput(input: PutArtifactInput): Buffer {
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

export async function putArtifact(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  input: PutArtifactInput,
  root = artifactRoot(),
) {
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
    await putBlob(root, bytes, digest);
    return withManifestLock(manifestPath(root, sessionId), async () => {
      const manifest = await readManifest(root, sessionId);
      manifest.artifacts[metadata.handle] = metadata;
      manifest.revoked = manifest.revoked.filter(
        (value) => value !== metadata.handle,
      );
      await writeManifest(root, manifest);
      pi.appendEntry(ARTIFACT_ENTRY_TYPE, {
        version: 1,
        kind: 'recovery',
        metadata,
        bytes: bytes.toString('base64'),
      } satisfies RecoveryEntry);
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
      if (!manifest.artifacts[handle]) return false;
      delete manifest.artifacts[handle];
      if (!manifest.revoked.includes(handle)) manifest.revoked.push(handle);
      await writeManifest(root, manifest);
      pi.appendEntry(ARTIFACT_ENTRY_TYPE, {
        version: 1,
        kind: 'revoke',
        handle,
        revokedAt: new Date().toISOString(),
      } satisfies TombstoneEntry);
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
    const recovered = new Map<string, RecoveryEntry>();
    const revoked = new Set<string>();
    // getEntries(), deliberately not getBranch(): recovery must survive tree changes.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== 'custom' || entry.customType !== ARTIFACT_ENTRY_TYPE)
        continue;
      const data = entry.data as RecoveryEntry | TombstoneEntry | undefined;
      if (data?.version !== 1) continue;
      if (
        (data.kind === 'revoke' || data.kind === 'purge') &&
        typeof data.handle === 'string' &&
        HANDLE_RE.test(data.handle) &&
        typeof (data.kind === 'revoke' ? data.revokedAt : data.purgedAt) ===
          'string' &&
        Number.isFinite(
          Date.parse(data.kind === 'revoke' ? data.revokedAt : data.purgedAt),
        )
      ) {
        recovered.delete(data.handle);
        revoked.add(data.handle);
      } else if (data.kind === 'recovery') {
        const metadata = data.metadata;
        if (
          metadata &&
          typeof metadata === 'object' &&
          typeof metadata.handle === 'string' &&
          HANDLE_RE.test(metadata.handle)
        ) {
          recovered.set(metadata.handle, data);
          revoked.delete(metadata.handle);
        }
      }
    }
    const manifest: Manifest = {
      version: 1,
      sessionId,
      artifacts: {},
      revoked: [...revoked],
    };
    for (const [handle, entry] of recovered) {
      if (
        typeof entry.bytes !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          entry.bytes,
        )
      )
        continue;
      const bytes = Buffer.from(entry.bytes, 'base64');
      try {
        validateMetadata(entry.metadata, bytes);
      } catch {
        continue;
      }
      await putBlob(root, bytes, entry.metadata.sha256);
      manifest.artifacts[handle] = entry.metadata;
    }
    await withManifestLock(manifestPath(root, sessionId), () =>
      writeManifest(root, manifest),
    );
    return Object.keys(manifest.artifacts).length;
  });
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

export async function clearArtifactRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
