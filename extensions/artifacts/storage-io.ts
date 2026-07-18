import { randomBytes } from 'node:crypto';
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
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { sha256 } from './storage-validation';
import type { Manifest } from './types';

const ROOT = 'artifacts/v1';

function sessionKey(sessionId: string): string {
  return sha256(sessionId);
}

export function artifactRoot(agentDir = getAgentDir()): string {
  return path.join(agentDir, ROOT);
}

export function blobPath(root: string, digest: string): string {
  return path.join(root, 'blobs', digest.slice(0, 2), digest.slice(2));
}

export function manifestPath(root: string, sessionId: string): string {
  return path.join(root, 'manifests', `${sessionKey(sessionId)}.json`);
}

export async function ensureDir(dir: string): Promise<void> {
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

export async function putBlob(
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

export async function readManifest(
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

export async function writeManifest(
  root: string,
  manifest: Manifest,
): Promise<void> {
  await atomicReplace(
    manifestPath(root, manifest.sessionId),
    `${JSON.stringify(manifest)}\n`,
  );
}

export async function clearArtifactRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
