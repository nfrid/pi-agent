import type { Dirent } from 'node:fs';
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { scanArtifactReferences } from './scan-entries';
import {
  ArtifactRootLockError,
  artifactRoot,
  withArtifactRootLock,
} from './storage';
import type { Manifest } from './types';

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

async function filesBelow(directory: string): Promise<string[]> {
  const found: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(target)));
    else if (entry.isFile()) found.push(target);
  }
  return found;
}

/**
 * Conservatively reconciles CAS blobs. Pi has no public session-deletion event,
 * so callers may run this periodically. Any unreadable/malformed session
 * aborts collection; live digests have no age expiry. A grace period only protects
 * newly-created, not-yet-flushed unreferenced blobs. Collection can unlink an
 * unreferenced CAS copy, but cannot remove base64 recovery bytes from append-only
 * session JSONL or standard exports.
 */
export async function collectGarbage(
  options: {
    agentDir?: string;
    root?: string;
    graceMs?: number;
    now?: number;
    lockTimeoutMs?: number;
  } = {},
): Promise<{ deleted: number; retained: number; aborted: boolean }> {
  const agentDir = options.agentDir ?? getAgentDir();
  const root = options.root ?? artifactRoot(agentDir);
  try {
    return await withArtifactRootLock(
      root,
      async () => {
        const referenced = new Set<string>();
        const activeSessionIds = new Set<string>();
        const sessions = (
          await filesBelow(path.join(agentDir, 'sessions'))
        ).filter((file) => file.endsWith('.jsonl'));
        // No session inventory means we cannot distinguish deleted sessions from a
        // temporarily unavailable session directory; never collect in that state.
        if (sessions.length === 0)
          return { deleted: 0, retained: 0, aborted: true };
        try {
          for (const file of sessions) {
            const entries = (await readFile(file, 'utf8'))
              .split('\n')
              .filter(Boolean)
              .map(
                (line) =>
                  JSON.parse(line) as {
                    type?: string;
                    id?: string;
                    customType?: string;
                    data?: unknown;
                  },
              );
            for (const entry of entries) {
              if (entry.type === 'session' && entry.id)
                activeSessionIds.add(entry.id);
            }
            for (const digest of scanArtifactReferences(
              entries as Array<{
                type: string;
                customType?: string;
                data?: unknown;
              }>,
            ).values())
              referenced.add(digest);
          }
          // Manifests cover an active-session flush race. Stale manifests are not roots:
          // without a deletion hook, the JSONL header scan reconciles deleted sessions.
          for (const file of await filesBelow(path.join(root, 'manifests'))) {
            const manifest = JSON.parse(
              await readFile(file, 'utf8'),
            ) as Manifest;
            if (manifest.version !== 1)
              throw new Error('Unknown artifact manifest');
            if (!activeSessionIds.has(manifest.sessionId)) continue;
            for (const metadata of Object.values(manifest.artifacts))
              referenced.add(metadata.sha256);
          }
        } catch {
          return { deleted: 0, retained: 0, aborted: true };
        }

        let deleted = 0;
        let retained = 0;
        const now = options.now ?? Date.now();
        const grace = Math.max(0, options.graceMs ?? DEFAULT_GRACE_MS);
        for (const file of await filesBelow(path.join(root, 'blobs'))) {
          const digest = `${path.basename(path.dirname(file))}${path.basename(file)}`;
          if (
            referenced.has(digest) ||
            now - (await stat(file)).mtimeMs < grace
          ) {
            retained++;
          } else {
            await unlink(file);
            deleted++;
          }
        }
        return { deleted, retained, aborted: false };
      },
      { maxWaitMs: options.lockTimeoutMs },
    );
  } catch (error) {
    if (error instanceof ArtifactRootLockError)
      return { deleted: 0, retained: 0, aborted: true };
    throw error;
  }
}
