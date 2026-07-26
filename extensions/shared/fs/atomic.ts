/**
 * One implementation of durable atomic file replacement.
 *
 * The invariant every caller depends on: a reader either sees the previous
 * complete file or the new complete file, never a partial one, and never a file
 * whose bytes are still only in the page cache when the process dies.
 *
 * That requires all four of these steps, which is why they live here once
 * instead of being restated per call site:
 *
 *   1. a temporary name unique per process *and* per call, so two concurrent
 *      writers to the same target cannot land on the same scratch file;
 *   2. `wx` creation, so a colliding name fails loudly instead of truncating
 *      someone else's in-flight write;
 *   3. `fsync` before the rename, so the rename cannot be reordered ahead of
 *      the data it publishes;
 *   4. `rename`, which is atomic within a filesystem.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export interface AtomicWriteOptions {
  /** Mode for the published file. Defaults to owner-only. */
  mode?: number;
  /** Mode for directories created along the way. Defaults to owner-only. */
  dirMode?: number;
}

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIR_MODE = 0o700;

/**
 * A scratch name that is unique across concurrent writers. The random suffix is
 * what makes this safe: pid alone collides when one process replaces the same
 * target twice concurrently, and a fixed `.tmp` suffix collides across every
 * writer.
 */
function temporaryPath(target: string): string {
  return `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
}

export async function ensureDir(
  dir: string,
  mode = DEFAULT_DIR_MODE,
): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
  // mkdir's mode is masked by the umask, and is ignored outright when the
  // directory already exists. Restate it so permissions are not left to the
  // caller's environment.
  await chmod(dir, mode);
}

export function ensureDirSync(dir: string, mode = DEFAULT_DIR_MODE): void {
  mkdirSync(dir, { recursive: true, mode });
}

/** Atomically replace `file` with `bytes`. */
export async function atomicWriteFile(
  file: string,
  bytes: Uint8Array | string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? DEFAULT_FILE_MODE;
  await ensureDir(path.dirname(file), options.dirMode ?? DEFAULT_DIR_MODE);
  const temporary = temporaryPath(file);
  const descriptor = await open(temporary, 'wx', mode);
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    await chmod(temporary, mode);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await chmod(file, mode);
}

/** Atomically replace `file` with newline-terminated JSON. */
export async function atomicWriteJson(
  file: string,
  value: unknown,
  options: AtomicWriteOptions & { indent?: number } = {},
): Promise<void> {
  const { indent, ...writeOptions } = options;
  await atomicWriteFile(
    file,
    `${JSON.stringify(value, null, indent)}\n`,
    writeOptions,
  );
}

/**
 * Synchronous atomic replacement, for call sites that run inside synchronous
 * lifecycle code. Prefer {@link atomicWriteFile} anywhere `await` is available.
 */
export function atomicWriteFileSync(
  file: string,
  bytes: Uint8Array | string,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? DEFAULT_FILE_MODE;
  ensureDirSync(path.dirname(file), options.dirMode ?? DEFAULT_DIR_MODE);
  const temporary = temporaryPath(file);
  const descriptor = openSync(temporary, 'wx', mode);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Synchronous atomic replacement with newline-terminated JSON. */
export function atomicWriteJsonSync(
  file: string,
  value: unknown,
  options: AtomicWriteOptions & { indent?: number } = {},
): void {
  const { indent, ...writeOptions } = options;
  atomicWriteFileSync(
    file,
    `${JSON.stringify(value, null, indent)}\n`,
    writeOptions,
  );
}
