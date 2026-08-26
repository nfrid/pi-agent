import { randomBytes } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { atomicWriteFile, ensureDir } from './fs/atomic';

/** Cache files are private agent-owned output, never repository/worktree data. */
export const CACHE_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const CACHE_FILE_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
export const CACHE_FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const CACHE_DIRECTORY = 'pi/files';
const EXTENSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

export interface CacheFile {
  path: string;
  size: number;
}

export function cacheFileRoot(
  cacheHome = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'),
): string {
  return path.resolve(cacheHome, CACHE_DIRECTORY);
}

function safeExtension(extension: string): string {
  const value = extension.startsWith('.') ? extension.slice(1) : extension;
  if (!EXTENSION_RE.test(value))
    throw new Error('Cache file extension must be a short safe extension.');
  return `.${value}`;
}

async function cleanupCacheFiles(
  root: string,
  now = Date.now(),
): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(root, entry.name);
      try {
        const details = await stat(filePath);
        if (now - details.mtimeMs > CACHE_FILE_MAX_AGE_MS) {
          await rm(filePath, { force: true });
          continue;
        }
        files.push({
          path: filePath,
          size: details.size,
          mtimeMs: details.mtimeMs,
        });
      } catch {
        // Cleanup is opportunistic; a concurrent or inaccessible file is harmless.
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= CACHE_FILE_MAX_TOTAL_BYTES) return;
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of files) {
      if (total <= CACHE_FILE_MAX_TOTAL_BYTES) break;
      try {
        await rm(file.path, { force: true });
        total -= file.size;
      } catch {
        // Publishing must not fail because an old cache file cannot be removed.
      }
    }
  } catch {
    // Publishing must not fail because the cache directory cannot be scanned.
  }
}

/** Write one opaque, owner-readable cache file and return only its path/size. */
export async function writeCacheFile(
  bytes: Uint8Array | string,
  extension: string,
  options: { cacheHome?: string } = {},
): Promise<CacheFile> {
  const content =
    typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
  if (content.length > CACHE_FILE_MAX_BYTES)
    throw new Error(`Cache file exceeds ${CACHE_FILE_MAX_BYTES} byte ceiling.`);
  const root = cacheFileRoot(options.cacheHome);
  await ensureDir(root, 0o700);
  const filePath = path.join(
    root,
    `${randomBytes(16).toString('hex')}${safeExtension(extension)}`,
  );
  await atomicWriteFile(filePath, content, { mode: 0o600, dirMode: 0o700 });
  void cleanupCacheFiles(root);
  return { path: filePath, size: content.length };
}

export async function clearCacheFiles(cacheHome?: string): Promise<void> {
  await rm(cacheFileRoot(cacheHome), { recursive: true, force: true });
}
