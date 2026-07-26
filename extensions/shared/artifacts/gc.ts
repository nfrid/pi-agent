import type { Dirent } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { artifactRoot, sessionDirectory } from './storage';

async function sessionFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sessionFiles(target)));
    else if (entry.isFile() && entry.name.endsWith('.jsonl'))
      found.push(target);
  }
  return found;
}

/**
 * Delete the artifacts of sessions that no longer exist.
 *
 * Pi has no session-deletion event, so this reconciles against the session
 * files themselves and is only ever run on demand. It is deliberately timid:
 * anything it cannot read makes it abort without deleting, because an
 * unreadable session inventory is indistinguishable from a session directory
 * that is temporarily unavailable. Recovery bytes in append-only session JSONL
 * are never touched.
 */
export async function collectGarbage(
  options: { agentDir?: string; root?: string } = {},
): Promise<{ deleted: number; retained: number; aborted: boolean }> {
  const agentDir = options.agentDir ?? getAgentDir();
  const root = options.root ?? artifactRoot(agentDir);
  const files = await sessionFiles(path.join(agentDir, 'sessions'));
  if (files.length === 0) return { deleted: 0, retained: 0, aborted: true };

  const live = new Set<string>();
  try {
    for (const file of files) {
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (!line) continue;
        const entry = JSON.parse(line) as { type?: string; id?: string };
        if (entry.type === 'session' && entry.id)
          live.add(sessionDirectory(root, entry.id));
      }
    }
  } catch {
    return { deleted: 0, retained: 0, aborted: true };
  }

  let deleted = 0;
  let retained = 0;
  let stored: Dirent[];
  try {
    stored = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { deleted: 0, retained: 0, aborted: false };
  }
  for (const entry of stored) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    if (live.has(target)) retained++;
    else {
      await rm(target, { recursive: true, force: true });
      deleted++;
    }
  }
  return { deleted, retained, aborted: false };
}
