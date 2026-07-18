import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { DelegateRouteState } from './types';

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

export interface DelegateSession {
  token: string;
  filePath: string;
  cwd: string;
  isolationId?: string;
  routing?: DelegateRouteState;
}

interface DelegateSessionMetadata {
  token: string;
  cwd: string;
  createdAt: string;
  isolationId?: string;
  routing?: DelegateRouteState;
}

const SESSION_VERSION = 4;
export const DELEGATE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DELEGATE_SESSION_MAX_UNLINKED = 200;
const ACTIVE_GRACE_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sessionDir(): string {
  return path.join(getAgentDir(), '.delegate-sessions');
}

function sessionPaths(token: string): {
  filePath: string;
  metadataPath: string;
} {
  const dir = sessionDir();
  return {
    filePath: path.join(dir, `${token}.jsonl`),
    metadataPath: path.join(dir, `${token}.json`),
  };
}

function initialSessionJsonl(
  token: string,
  cwd: string,
  createdAt: string,
  snapshotJsonl?: string,
): string {
  if (!snapshotJsonl?.trim()) {
    return `${JSON.stringify({
      type: 'session',
      version: SESSION_VERSION,
      id: token,
      timestamp: createdAt,
      cwd,
    })}\n`;
  }

  const lines = snapshotJsonl.split(/\r?\n/).filter((line) => line.trim());
  const parsed = lines.map((line) => JSON.parse(line) as unknown);
  const headerIndex = parsed.findIndex(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'session',
  );
  if (headerIndex < 0)
    throw new Error('Cannot create delegate session: snapshot has no header.');
  const sourceHeader = parsed[headerIndex] as Record<string, unknown>;
  parsed[headerIndex] = {
    ...sourceHeader,
    id: token,
    timestamp: createdAt,
    cwd,
  };
  return `${parsed.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/** Create a durable child session and return its opaque continuation token. */
export function createDelegateSession(options: {
  cwd: string;
  snapshotJsonl?: string;
  isolationId?: string;
  routing?: DelegateRouteState;
}): DelegateSession {
  const token = randomUUID();
  const createdAt = new Date().toISOString();
  const dir = sessionDir();
  const { filePath, metadataPath } = sessionPaths(token);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      filePath,
      initialSessionJsonl(token, options.cwd, createdAt, options.snapshotJsonl),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    const metadata: DelegateSessionMetadata = {
      token,
      cwd: options.cwd,
      createdAt,
      ...(options.isolationId ? { isolationId: options.isolationId } : {}),
      ...(options.routing ? { routing: options.routing } : {}),
    };
    writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    rmSync(filePath, { force: true });
    rmSync(metadataPath, { force: true });
    throw error;
  }
  return {
    token,
    filePath,
    cwd: options.cwd,
    ...(options.isolationId ? { isolationId: options.isolationId } : {}),
    ...(options.routing ? { routing: options.routing } : {}),
  };
}

/** Resolve a continuation token without allowing arbitrary path access. */
export function resolveDelegateSession(token: string): DelegateSession | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const { filePath, metadataPath } = sessionPaths(token);
  if (!existsSync(filePath) || !existsSync(metadataPath)) return null;
  try {
    const metadata = JSON.parse(
      readFileSync(metadataPath, 'utf8'),
    ) as Partial<DelegateSessionMetadata>;
    if (
      metadata.token !== token ||
      typeof metadata.cwd !== 'string' ||
      !metadata.cwd
    )
      return null;
    return {
      token,
      filePath,
      cwd: metadata.cwd,
      ...(typeof metadata.isolationId === 'string'
        ? { isolationId: metadata.isolationId }
        : {}),
      ...(metadata.routing && typeof metadata.routing === 'object'
        ? { routing: metadata.routing }
        : {}),
    };
  } catch {
    return null;
  }
}

export function updateDelegateSessionRouting(
  token: string,
  routing: DelegateRouteState | undefined,
): DelegateSession | null {
  const current = resolveDelegateSession(token);
  if (!current) return null;
  const { metadataPath } = sessionPaths(token);
  const metadata = JSON.parse(
    readFileSync(metadataPath, 'utf8'),
  ) as DelegateSessionMetadata;
  const temporary = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const updated = { ...metadata, routing };
    if (!routing) delete updated.routing;
    writeFileSync(temporary, `${JSON.stringify(updated)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, metadataPath);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (routing) return { ...current, routing };
  const { routing: _routing, ...withoutRouting } = current;
  return withoutRouting;
}

export function removeDelegateSession(session: DelegateSession): void {
  const paths = sessionPaths(session.token);
  rmSync(paths.filePath, { force: true });
  rmSync(paths.metadataPath, { force: true });
}

/**
 * Prune durable read-only/unlinked transcripts. Isolation-linked evidence is
 * retained with its worktree. Recently-written files are protected so another
 * Pi process cannot have an active transcript removed underneath it.
 */
export function pruneDelegateSessions(options: {
  now?: number;
  isIsolationRetained: (id: string) => boolean;
}): { removed: number } {
  const now = options.now ?? Date.now();
  const dir = sessionDir();
  if (!existsSync(dir)) return { removed: 0 };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { removed: 0 };
  }
  const candidates: Array<{ session: DelegateSession; touchedAt: number }> = [];
  for (const name of names) {
    try {
      const match = /^([0-9a-f-]{36})\.json$/.exec(name);
      if (!match || !TOKEN_PATTERN.test(match[1])) continue;
      const session = resolveDelegateSession(match[1]);
      if (!session) continue;
      if (
        session.isolationId &&
        options.isIsolationRetained(session.isolationId)
      )
        continue;
      const paths = sessionPaths(session.token);
      const touchedAt = Math.max(
        statSync(paths.filePath).mtimeMs,
        statSync(paths.metadataPath).mtimeMs,
      );
      if (now - touchedAt < ACTIVE_GRACE_MS) continue;
      candidates.push({ session, touchedAt });
    } catch {
      // Concurrent cleanup or malformed metadata is ignored safely.
    }
  }
  candidates.sort((left, right) => right.touchedAt - left.touchedAt);
  let removed = 0;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (
      now - candidate.touchedAt <= DELEGATE_SESSION_MAX_AGE_MS &&
      index < DELEGATE_SESSION_MAX_UNLINKED
    )
      continue;
    try {
      removeDelegateSession(candidate.session);
      removed++;
    } catch {
      // Best-effort retention cleanup must not break session startup.
    }
  }
  return { removed };
}

function containsToolCall(entry: unknown, toolCallId: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const message = (entry as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return false;
  const content = (message as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'toolCall' &&
        (part as { id?: unknown }).id === toolCallId,
    )
  );
}

export function buildSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
  options: { cwd?: string; excludeToolCallId?: string } = {},
): string | null {
  const sourceHeader = sessionManager.getHeader();
  if (!sourceHeader || typeof sourceHeader !== 'object') return null;
  const header = options.cwd
    ? { ...(sourceHeader as Record<string, unknown>), cwd: options.cwd }
    : sourceHeader;
  const branch = sessionManager.getBranch();
  const cutoff = options.excludeToolCallId
    ? branch.findIndex((entry) =>
        containsToolCall(entry, options.excludeToolCallId as string),
      )
    : -1;
  const entries = cutoff >= 0 ? branch.slice(0, cutoff) : branch;

  return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}
