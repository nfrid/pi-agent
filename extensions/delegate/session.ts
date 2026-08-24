import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
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
import { atomicWriteFileSync, atomicWriteJsonSync } from '../shared/fs/atomic';
import { createOpaqueId, deriveCompatibilityLineageId } from './identity';
import type { DelegateIsolation, DelegateRouteState } from './types';

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

export interface DelegateSession {
  token: string;
  /** Canonical Pi session identity used by dashboard session APIs. */
  sessionId: string;
  /** Stable child-session lineage shared by all continuations. */
  lineageId: string;
  /** Immutable original parent session for nested delegates. */
  parentSessionId?: string;
  filePath: string;
  cwd: string;
  /** The original fresh-run display name; absent only on legacy metadata. */
  name?: string;
  worktreeId?: string;
  /** The original task capability; continuations inherit it when omitted. */
  allowWrites?: boolean;
  /** The original workspace mode; continuations reuse its checkout. */
  isolation: DelegateIsolation;
  /** Advisory paths the parent named; replayed so continuations keep them. */
  scope?: string[];
  routing?: DelegateRouteState;
}

interface DelegateSessionMetadata {
  token: string;
  /** Absent only in metadata written before lineage identities existed. */
  lineageId?: string;
  /** Immutable original parent session for nested delegates. */
  parentSessionId?: string;
  /** Durable marker used by the dashboard auxiliary-session projection. */
  sessionKind?: 'delegate';
  cwd: string;
  createdAt: string;
  /** Persisted for new sessions so continuations can omit their name. */
  name?: string;
  worktreeId?: string;
  allowWrites?: boolean;
  isolation?: DelegateIsolation;
  scope?: string[];
  routing?: DelegateRouteState;
}

const SESSION_VERSION = 4;
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DELEGATE_SESSION_MAX_AGE_MS = SESSION_MAX_AGE_MS;
const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validParentSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function sessionDir(): string {
  return (
    process.env.PI_DELEGATE_SESSION_DIR?.trim() ||
    path.join(getAgentDir(), '.delegate-sessions')
  );
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
  options: {
    snapshotJsonl?: string;
    name?: string;
    lineageId: string;
    parentSessionId?: string;
  },
): string {
  const delegateHeader = {
    sessionKind: 'delegate' as const,
    ...(options.name ? { name: options.name } : {}),
    lineageId: options.lineageId,
    ...(options.parentSessionId
      ? { parentSessionId: options.parentSessionId }
      : {}),
  };
  if (!options.snapshotJsonl?.trim()) {
    return `${JSON.stringify({
      type: 'session',
      version: SESSION_VERSION,
      id: token,
      timestamp: createdAt,
      cwd,
      ...delegateHeader,
    })}\n`;
  }

  const lines = options.snapshotJsonl
    .split(/\r?\n/)
    .filter((line) => line.trim());
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
    ...delegateHeader,
  };
  return `${parsed.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/** Create a durable child session and return its opaque continuation token. */
export function createDelegateSession(options: {
  cwd: string;
  /** Fresh delegate display name; omitted only by legacy-session fixtures. */
  name?: string;
  snapshotJsonl?: string;
  worktreeId?: string;
  allowWrites?: boolean;
  isolation?: DelegateIsolation;
  scope?: string[];
  routing?: DelegateRouteState;
  /** Original parent Pi session; immutable across continuations and rewrites. */
  parentSessionId?: string;
}): DelegateSession {
  if (
    options.parentSessionId !== undefined &&
    !validParentSessionId(options.parentSessionId)
  )
    throw new Error('Invalid delegate parent session identity.');
  const token = randomUUID();
  const lineageId = createOpaqueId();
  const createdAt = new Date().toISOString();
  const dir = sessionDir();
  const { filePath, metadataPath } = sessionPaths(token);
  const name = options.name?.trim();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      filePath,
      initialSessionJsonl(token, options.cwd, createdAt, {
        snapshotJsonl: options.snapshotJsonl,
        name,
        lineageId,
        parentSessionId: options.parentSessionId,
      }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    const metadata: DelegateSessionMetadata = {
      token,
      sessionKind: 'delegate',
      lineageId,
      ...(options.parentSessionId
        ? { parentSessionId: options.parentSessionId }
        : {}),
      cwd: options.cwd,
      createdAt,
      ...(name ? { name } : {}),
      ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
      allowWrites: options.allowWrites ?? false,
      isolation:
        options.isolation ?? (options.worktreeId ? 'worktree' : 'shared'),
      ...(options.scope?.length ? { scope: options.scope } : {}),
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
    sessionId: token,
    lineageId,
    ...(options.parentSessionId
      ? { parentSessionId: options.parentSessionId }
      : {}),
    filePath,
    cwd: options.cwd,
    ...(name ? { name } : {}),
    ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
    allowWrites: options.allowWrites ?? false,
    isolation:
      options.isolation ?? (options.worktreeId ? 'worktree' : 'shared'),
    ...(options.scope?.length ? { scope: options.scope } : {}),
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
      sessionId: token,
      lineageId:
        typeof metadata.lineageId === 'string' && metadata.lineageId.trim()
          ? metadata.lineageId.trim()
          : deriveCompatibilityLineageId(token),
      ...(validParentSessionId(metadata.parentSessionId)
        ? { parentSessionId: metadata.parentSessionId }
        : {}),
      filePath,
      cwd: metadata.cwd,
      ...(typeof metadata.name === 'string' && metadata.name.trim()
        ? { name: metadata.name.trim() }
        : {}),
      ...(typeof metadata.worktreeId === 'string'
        ? { worktreeId: metadata.worktreeId }
        : {}),
      ...(typeof metadata.allowWrites === 'boolean'
        ? { allowWrites: metadata.allowWrites }
        : {}),
      // Sessions from before isolation persistence used a worktree exactly
      // when they carried a worktree id.
      isolation:
        metadata.isolation === 'worktree' || metadata.isolation === 'shared'
          ? metadata.isolation
          : typeof metadata.worktreeId === 'string'
            ? 'worktree'
            : 'shared',
      ...(Array.isArray(metadata.scope) ? { scope: metadata.scope } : {}),
      ...(metadata.routing && typeof metadata.routing === 'object'
        ? { routing: metadata.routing }
        : {}),
    };
  } catch {
    return null;
  }
}

export function updateDelegateSessionWorktree(
  token: string,
  worktreeId: string,
  cwd: string,
): DelegateSession | null {
  const current = resolveDelegateSession(token);
  if (!current) return null;
  const { filePath, metadataPath } = sessionPaths(token);
  const metadata = JSON.parse(
    readFileSync(metadataPath, 'utf8'),
  ) as DelegateSessionMetadata;
  const previousJsonl = readFileSync(filePath, 'utf8');
  const entries = previousJsonl
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
  const headerIndex = entries.findIndex(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'session',
  );
  if (headerIndex < 0)
    throw new Error('Cannot update delegate session: session has no header.');
  const header = entries[headerIndex] as Record<string, unknown>;
  entries[headerIndex] = { ...header, cwd };
  const updatedJsonl = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

  // Pi validates the session header's cwd before it starts the child. Keep it
  // synchronized with our routing metadata when a snapshot gets a replacement
  // checkout. If metadata persistence fails, restore the transcript so a
  // failed refresh leaves both durable session views on the old checkout.
  atomicWriteFileSync(filePath, updatedJsonl);
  try {
    atomicWriteJsonSync(metadataPath, { ...metadata, worktreeId, cwd });
  } catch (error) {
    try {
      atomicWriteFileSync(filePath, previousJsonl);
    } catch (rollbackError) {
      throw new Error(
        `Could not update delegate session metadata and could not restore its transcript: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { ...current, worktreeId, cwd };
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
  const updated = { ...metadata, routing };
  if (!routing) delete updated.routing;
  atomicWriteJsonSync(metadataPath, updated);
  if (routing) return { ...current, routing };
  const { routing: _routing, ...withoutRouting } = current;
  return withoutRouting;
}

export function removeDelegateSession(session: DelegateSession): void {
  const paths = sessionPaths(session.token);
  rmSync(paths.filePath, { force: true });
  rmSync(paths.metadataPath, { force: true });
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function archiveFiles(
  files: readonly string[],
  sourceDirectory: string,
  archiveDirectory: string,
): boolean {
  const sourceRoot = path.resolve(sourceDirectory);
  const archiveRoot = path.resolve(archiveDirectory);
  if (isWithin(sourceRoot, archiveRoot)) return false;
  const destinations = files.map((file) =>
    path.join(archiveRoot, path.relative(sourceRoot, path.resolve(file))),
  );
  if (destinations.some((file) => existsSync(file))) return false;
  try {
    for (const file of files) {
      if (!lstatSync(file).isFile()) return false;
    }
    for (const destination of destinations)
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    let moved = 0;
    try {
      for (; moved < files.length; moved++)
        renameSync(files[moved], destinations[moved]);
      return true;
    } catch {
      for (let index = moved - 1; index >= 0; index--) {
        try {
          renameSync(destinations[index], files[index]);
        } catch {
          // Best-effort rollback keeps the cleanup non-fatal.
        }
      }
      return false;
    }
  } catch {
    return false;
  }
}

function sessionFiles(directory: string, result: string[] = []): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) sessionFiles(file, result);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(file);
  }
  return result;
}

/** Move old ordinary session transcripts outside the live session tree. */
export function archiveOldSessionFiles(options: {
  directory: string;
  archiveDirectory: string;
  excludePaths?: readonly string[];
  now?: number;
  maxAgeMs?: number;
}): { archived: number } {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? SESSION_MAX_AGE_MS;
  const excluded = new Set(
    (options.excludePaths ?? []).map((file) => path.resolve(file)),
  );
  let archived = 0;
  for (const file of sessionFiles(options.directory)) {
    const resolved = path.resolve(file);
    if (excluded.has(resolved)) continue;
    try {
      if (now - statSync(resolved).mtimeMs <= maxAgeMs) continue;
      if (archiveFiles([resolved], options.directory, options.archiveDirectory))
        archived++;
    } catch {
      // Best-effort retention cleanup must not break session startup.
    }
  }
  return { archived };
}

/** Archive aged unlinked delegate transcripts and their metadata together. */
export function pruneDelegateSessions(options: {
  now?: number;
  isWorktreeRetained: (id: string) => boolean;
  archiveDirectory?: string;
}): { removed: number } {
  const now = options.now ?? Date.now();
  const dir = sessionDir();
  if (!existsSync(dir)) return { removed: 0 };
  const archiveDirectory =
    options.archiveDirectory ??
    path.join(path.dirname(dir), 'session-archive', '.delegate-sessions');
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
      if (session.worktreeId && options.isWorktreeRetained(session.worktreeId))
        continue;
      const paths = sessionPaths(session.token);
      const touchedAt = Math.max(
        statSync(paths.filePath).mtimeMs,
        statSync(paths.metadataPath).mtimeMs,
      );
      if (now - touchedAt <= DELEGATE_SESSION_MAX_AGE_MS) continue;
      candidates.push({ session, touchedAt });
    } catch {
      // Concurrent cleanup or malformed metadata is ignored safely.
    }
  }
  let removed = 0;
  for (const candidate of candidates) {
    const paths = sessionPaths(candidate.session.token);
    if (
      archiveFiles([paths.filePath, paths.metadataPath], dir, archiveDirectory)
    )
      removed++;
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
