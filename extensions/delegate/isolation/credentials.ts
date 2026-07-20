import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { SAFE_ID } from './constants';
import { delegateChildEnvironment } from './kernel';
import { processIdentity } from './locks';
import type { PreparedChildAuth, PreparedIsolation } from './model';
import { delegateStateRoot, isolationRootDir, loadIsolation } from './records';

const READ_ONLY_ROOT = 'delegate-readonly/v1';
function readOnlyRootDir(): string {
  return path.join(delegateStateRoot(), READ_ONLY_ROOT);
}

export function scrubIsolationCredentials(
  isolation: PreparedIsolation | undefined,
): void {
  if (isolation)
    rmSync(path.join(isolation.record.scratchPath, 'agent'), {
      recursive: true,
      force: true,
    });
}

export function writeCredentialOwner(directory: string): void {
  writeFileSync(
    path.join(directory, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

export function prepareChildAuth(): PreparedChildAuth {
  const directory = path.join(readOnlyRootDir(), randomUUID());
  const scratchPath = path.join(directory, 'scratch');
  mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
  writeCredentialOwner(directory);
  return { directory, env: delegateChildEnvironment(scratchPath) };
}

export function discardChildAuth(auth: PreparedChildAuth | undefined): void {
  if (auth) rmSync(auth.directory, { recursive: true, force: true });
}

export function scrubStaleIsolationCredentials(): number {
  let removed = 0;
  if (existsSync(isolationRootDir())) {
    for (const id of readdirSync(isolationRootDir())) {
      if (!SAFE_ID.test(id)) continue;
      const record = loadIsolation(id);
      if (!record) continue;
      const credentialDir = path.join(record.scratchPath, 'agent');
      if (!existsSync(credentialDir)) continue;
      const ownerActive =
        record.runOwner &&
        processIdentity(record.runOwner.pid) === record.runOwner.identity;
      if (ownerActive) continue;
      rmSync(credentialDir, { recursive: true, force: true });
      removed++;
    }
  }
  if (existsSync(readOnlyRootDir())) {
    for (const name of readdirSync(readOnlyRootDir())) {
      const directory = path.join(readOnlyRootDir(), name);
      const credentialDir = path.join(directory, 'scratch', 'agent');
      if (!existsSync(credentialDir)) continue;
      let ownerActive = false;
      try {
        const owner = JSON.parse(
          readFileSync(path.join(directory, 'owner.json'), 'utf8'),
        ) as { pid?: unknown; identity?: unknown };
        ownerActive =
          typeof owner.pid === 'number' &&
          typeof owner.identity === 'string' &&
          processIdentity(owner.pid) === owner.identity;
      } catch {
        ownerActive = false;
      }
      if (ownerActive) continue;
      rmSync(directory, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
