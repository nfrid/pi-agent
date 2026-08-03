import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceTarget } from '@pi-dashboard/protocol';

const execFileAsync = promisify(execFile);

export interface SeshEntryLike {
  Src?: unknown;
  Name?: unknown;
  Path?: unknown;
  source?: unknown;
  name?: unknown;
  path?: unknown;
  GitRoot?: unknown;
  gitRoot?: unknown;
  [key: string]: unknown;
}

function stringValue(...values: unknown[]): string | undefined {
  return values
    .find(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    )
    ?.trim();
}

function canonical(value: string): string {
  const absolute = path.resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return path.normalize(absolute);
  }
}

function workspaceId(pathValue: string, gitRoot?: string): string {
  return createHash('sha256')
    .update(gitRoot ?? pathValue)
    .digest('hex')
    .slice(0, 20);
}

export function normalizeSeshEntries(
  entries: readonly SeshEntryLike[],
  activeTmuxSessions: readonly string[] = [],
): WorkspaceTarget[] {
  const active = new Set(activeTmuxSessions);
  const merged = new Map<string, WorkspaceTarget>();
  for (const entry of entries) {
    const rawPath = stringValue(entry.Path, entry.path);
    if (!rawPath) continue;
    const canonicalPath = canonical(rawPath);
    const name =
      stringValue(entry.Name, entry.name) ?? path.basename(canonicalPath);
    const sourceRaw = stringValue(entry.Src, entry.source);
    const source: WorkspaceTarget['source'] =
      sourceRaw === 'tmux' ||
      sourceRaw === 'sesh-config' ||
      sourceRaw === 'zoxide' ||
      sourceRaw === 'directory'
        ? sourceRaw
        : 'directory';
    const gitRootRaw = stringValue(entry.GitRoot, entry.gitRoot);
    const gitRoot = gitRootRaw ? canonical(gitRootRaw) : undefined;
    const key = gitRoot ?? canonicalPath;
    const existing = merged.get(key);
    const tmuxSession =
      source === 'tmux' && active.has(name) ? name : existing?.tmuxSession;
    const next: WorkspaceTarget = existing
      ? {
          ...existing,
          name: existing.name || name,
          tmuxSession: tmuxSession ?? existing.tmuxSession,
          active: existing.active || active.has(name),
        }
      : {
          id: workspaceId(canonicalPath, gitRoot),
          name,
          path: path.resolve(rawPath),
          canonicalPath,
          gitRoot,
          source,
          tmuxSession,
          active: active.has(name),
        };
    merged.set(key, next);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface SeshAdapter {
  list(): Promise<WorkspaceTarget[]>;
}

export class CliSeshAdapter implements SeshAdapter {
  constructor(private readonly executable = 'sesh') {}

  async list(): Promise<WorkspaceTarget[]> {
    const result = await execFileAsync(
      this.executable,
      ['list', '--json', '--hide-duplicates'],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed))
      throw new Error('Sesh returned a non-list response.');
    const tmux = await this.activeTmuxSessions();
    return normalizeSeshEntries(
      parsed.filter(
        (entry): entry is SeshEntryLike =>
          typeof entry === 'object' && entry !== null,
      ),
      tmux,
    );
  }

  private async activeTmuxSessions(): Promise<string[]> {
    try {
      const result = await execFileAsync(
        'tmux',
        ['list-sessions', '-F', '#{session_name}'],
        { maxBuffer: 128 * 1024 },
      );
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

export function workspacePathIsUsable(workspace: WorkspaceTarget): boolean {
  return existsSync(workspace.canonicalPath);
}
