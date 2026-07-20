import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { SAFE_ID } from './constants';
import { isolationRootDir } from './records';

export function processIdentity(pid: number): string | undefined {
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return;
  }
}

function liveLock(lockPath: string): boolean {
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid?: unknown;
      processIdentity?: unknown;
    };
    if (
      typeof lock.pid !== 'number' ||
      typeof lock.processIdentity !== 'string'
    )
      return false;
    process.kill(lock.pid, 0);
    return processIdentity(lock.pid) === lock.processIdentity;
  } catch {
    return false;
  }
}

async function withBrokerLock<T>(
  name: string,
  details: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = path.join(isolationRootDir(), 'locks');
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locks, `${name}.lock`);
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2 && descriptor === undefined; attempt++) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
    } catch {
      if (liveLock(lockPath))
        throw new Error(`Another patch-broker operation holds lock ${name}`);
      try {
        renameSync(lockPath, `${lockPath}.stale-${Date.now()}-${process.pid}`);
      } catch {
        if (attempt === 1)
          throw new Error(`Could not recover stale patch-broker lock ${name}`);
      }
    }
  }
  if (descriptor === undefined)
    throw new Error(`Could not acquire patch-broker lock ${name}`);
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, processIdentity: processIdentity(process.pid), createdAt: new Date().toISOString(), ...details })}\n`,
    );
    return await operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      // The operation is complete; doctor reports retained unexpected locks.
    }
  }
}

export async function withRepositoryLock<T>(
  repositoryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = createHash('sha256').update(repositoryRoot).digest('hex');
  return withBrokerLock(`repository-${key}`, { repositoryRoot }, operation);
}

export async function withIsolationLock<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!SAFE_ID.test(id)) throw new Error('Invalid isolation identifier');
  return withBrokerLock(`isolation-${id}`, { isolationId: id }, operation);
}
