import { randomBytes } from 'node:crypto';
import { chmod, link, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './storage-io';

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

export async function withManifestLock<T>(
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
