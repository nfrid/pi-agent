import { createHash, type Hash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  deriveSessionTitle,
  isRecord,
  redactImageData,
  type SessionIndexEntry,
  validateSessionName,
  type WorkspaceTarget,
  workspaceForPath,
} from '@pi-dashboard/protocol';
import type { MetadataStore } from './metadata.js';

interface IndexedFile extends SessionIndexEntry {
  header: Record<string, unknown>;
  lastEntryId?: string;
}

export interface SessionHistoryPage {
  version: 1;
  start: number;
  end: number;
  hasOlder: boolean;
  nextBefore?: string;
}

interface HistoryCursor {
  version: 1;
  sessionId: string;
  file: string;
  dev: number;
  ino: number;
  size: number;
  prefixHash: string;
  before: number;
  /** Active branch leaf when the page was branch-filtered. */
  leafId?: string;
}

const HISTORY_PAGE_BYTES = 8 * 1024 * 1024;

function updateHistoryHash(hash: Hash, serialized: string): void {
  const bytes = Buffer.byteLength(serialized);
  hash.update(`${bytes}:`, 'utf8');
  hash.update(serialized, 'utf8');
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeHistoryCursor(value: string): HistoryCursor {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > 4096
  )
    throw new Error('Invalid history cursor.');
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<HistoryCursor>;
    if (
      decoded.version !== 1 ||
      typeof decoded.sessionId !== 'string' ||
      typeof decoded.file !== 'string' ||
      typeof decoded.dev !== 'number' ||
      !Number.isSafeInteger(decoded.dev) ||
      typeof decoded.ino !== 'number' ||
      !Number.isSafeInteger(decoded.ino) ||
      typeof decoded.size !== 'number' ||
      !Number.isSafeInteger(decoded.size) ||
      typeof decoded.prefixHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(decoded.prefixHash) ||
      typeof decoded.before !== 'number' ||
      !Number.isSafeInteger(decoded.before) ||
      decoded.before <= 0 ||
      (decoded.leafId !== undefined &&
        (typeof decoded.leafId !== 'string' || decoded.leafId.length === 0))
    )
      throw new Error();
    return decoded as HistoryCursor;
  } catch {
    throw new Error('Invalid history cursor.');
  }
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function workspaceFor(
  cwd: string,
  workspaces: readonly WorkspaceTarget[],
): string | undefined {
  const normalized = path.resolve(cwd);
  return workspaceForPath(normalized, workspaces)?.id;
}

export class SessionIndex {
  private readonly files = new Map<string, IndexedFile>();
  private readonly fileIds = new Map<string, string>();
  private watcher?: ReturnType<typeof import('node:fs').watch>;
  private watcherRetry?: NodeJS.Timeout;
  private readonly scheduled = new Map<string, NodeJS.Timeout>();
  private readonly indexing = new Map<string, Promise<void>>();
  private workspaces: readonly WorkspaceTarget[] = [];
  constructor(
    private readonly sessionDir: string,
    private readonly metadata?: MetadataStore,
    private readonly onChange?: () => void,
  ) {}

  async rebuild(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    this.files.clear();
    this.fileIds.clear();
    const paths = await this.findJsonl(this.sessionDir);
    for (const file of paths)
      await this.indexFile(file, this.workspaces).catch(() => undefined);
  }

  async start(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    await this.rebuild(this.workspaces);
    await this.ensureWatcher();
  }

  async refresh(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    await this.rebuild(this.workspaces);
  }

  list(workspaceId?: string): SessionIndexEntry[] {
    return [...this.files.values()]
      .filter((file) => !workspaceId || file.workspaceId === workspaceId)
      .map(({ header: _header, lastEntryId: _lastEntryId, ...entry }) => entry)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SessionIndexEntry | undefined {
    const entry = this.files.get(id);
    if (!entry) return undefined;
    const {
      header: _header,
      lastEntryId: _lastEntryId,
      ...publicEntry
    } = entry;
    return publicEntry;
  }

  // TODO: switch older pages to reverse-file reads if page counts grow; the
  // bounded streaming scan keeps current history sizes simple and safe.
  async readEntries(
    id: string,
    before?: string,
    leafId?: string,
  ): Promise<{
    metadata: SessionIndexEntry;
    entries: unknown[];
    entriesComplete: boolean;
    history: SessionHistoryPage;
  }> {
    const indexed = this.files.get(id);
    if (!indexed || !within(path.resolve(this.sessionDir), indexed.file))
      throw new Error('Unknown session.');
    const stat = await fs.stat(indexed.file).catch(() => undefined);
    if (!stat) throw new Error('Unknown session.');
    const cursor =
      before === undefined ? undefined : decodeHistoryCursor(before);
    const requestedLeafId = leafId ?? cursor?.leafId;
    if (
      cursor &&
      (cursor.sessionId !== id ||
        cursor.file !== indexed.file ||
        cursor.dev !== stat.dev ||
        cursor.ino !== stat.ino ||
        stat.size < cursor.size ||
        cursor.leafId !== requestedLeafId)
    )
      throw new Error('Stale history cursor.');
    const upperBound = cursor?.before;
    const { header: _header, lastEntryId: _lastEntryId, ...metadata } = indexed;
    if (requestedLeafId !== undefined)
      return this.readBranchEntries(
        id,
        indexed.file,
        stat,
        metadata,
        requestedLeafId,
        cursor,
      );
    type PageEntry = {
      ordinal: number;
      entry: unknown;
      prefixHash: string;
      bytes: number;
    };
    const page: PageEntry[] = [];
    let pageBytes = 0;
    let ordinal = 0;
    // The seen hash validates a cursor before its page has necessarily filled
    // the budget. Each retained entry snapshots the hash before its ordinal,
    // so nextBefore needs no retained original serialization.
    const seenHasher = createHash('sha256');
    let reachedUpperBound = false;
    const input = createReadStream(indexed.file, { encoding: 'utf8' });
    const lines = readline.createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (upperBound !== undefined && ordinal === upperBound) {
          reachedUpperBound = true;
          break;
        }
        if (Buffer.byteLength(line) > 24 * 1024 * 1024)
          throw new Error('A session entry is too large to open remotely.');
        try {
          const entry = redactImageData(JSON.parse(line) as unknown);
          const serialized = JSON.stringify(entry);
          const originalBytes = Buffer.byteLength(serialized);
          const outputEntry =
            originalBytes > HISTORY_PAGE_BYTES
              ? {
                  type: 'history_omission',
                  ...(isRecord(entry) && typeof entry.id === 'string'
                    ? { id: entry.id }
                    : {}),
                  ...(isRecord(entry) && typeof entry.type === 'string'
                    ? { originalType: entry.type }
                    : {}),
                  reason: 'entry-exceeds-page-budget',
                  originalBytes,
                }
              : entry;
          const prefixHash = seenHasher.copy().digest('hex');
          updateHistoryHash(seenHasher, serialized);
          const outputBytes = Buffer.byteLength(JSON.stringify(outputEntry));
          page.push({
            ordinal,
            entry: outputEntry,
            prefixHash,
            bytes: outputBytes,
          });
          pageBytes += outputBytes;
          while (pageBytes > HISTORY_PAGE_BYTES && page.length > 0) {
            const shifted = page.shift();
            if (!shifted) break;
            pageBytes -= shifted.bytes;
          }
          ordinal += 1;
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    if (upperBound !== undefined && ordinal === upperBound)
      reachedUpperBound = true;
    if (
      upperBound !== undefined &&
      (!reachedUpperBound ||
        seenHasher.copy().digest('hex') !== cursor?.prefixHash)
    )
      throw new Error('Stale history cursor.');
    const end = upperBound ?? ordinal;
    const start = page[0]?.ordinal ?? end;
    const hasOlder = start > 0;
    const nextBefore = hasOlder
      ? encodeHistoryCursor({
          version: 1,
          sessionId: id,
          file: indexed.file,
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          prefixHash: page[0]?.prefixHash ?? seenHasher.copy().digest('hex'),
          before: start,
        })
      : undefined;
    const entriesComplete = before === undefined && start === 0;
    return {
      metadata,
      entries: page.map((item) => item.entry),
      entriesComplete,
      history: {
        version: 1,
        start,
        end,
        hasOlder,
        ...(nextBefore === undefined ? {} : { nextBefore }),
      },
    };
  }

  /**
   * Read only the ancestry rooted at an active runtime leaf. A normal session
   * read intentionally retains append-only history semantics; branch reads are
   * selected explicitly because the file can contain multiple trees.
   */
  private async readBranchEntries(
    id: string,
    file: string,
    stat: { dev: number; ino: number; size: number },
    metadata: SessionIndexEntry,
    leafId: string,
    cursor: HistoryCursor | undefined,
  ): Promise<{
    metadata: SessionIndexEntry;
    entries: unknown[];
    entriesComplete: boolean;
    history: SessionHistoryPage;
  }> {
    const parents = new Map<string, unknown>();
    const ordinals = new Map<string, number>();
    let headerSeen = false;
    let sourceOrdinal = 0;
    const firstPassInput = createReadStream(file, { encoding: 'utf8' });
    const firstPassLines = readline.createInterface({
      input: firstPassInput,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of firstPassLines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 24 * 1024 * 1024)
          throw new Error('A session entry is too large to open remotely.');
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        if (!headerSeen) {
          if (!isRecord(parsed) || parsed.type !== 'session')
            throw new Error('Invalid session branch.');
          headerSeen = true;
        } else if (isRecord(parsed) && typeof parsed.id === 'string') {
          if (parents.has(parsed.id))
            throw new Error('Invalid session branch.');
          parents.set(parsed.id, parsed.parentId);
          ordinals.set(parsed.id, sourceOrdinal);
        }
        sourceOrdinal += 1;
      }
    } finally {
      firstPassLines.close();
      firstPassInput.destroy();
    }
    if (!headerSeen || !parents.has(leafId))
      throw new Error('Invalid session branch.');

    const branchIds = new Set<string>();
    let currentId = leafId;
    while (true) {
      if (branchIds.has(currentId)) throw new Error('Invalid session branch.');
      branchIds.add(currentId);
      const parentId = parents.get(currentId);
      if (parentId === undefined || parentId === null) break;
      if (typeof parentId !== 'string' || !parents.has(parentId))
        throw new Error('Invalid session branch.');
      const currentOrdinal = ordinals.get(currentId);
      const parentOrdinal = ordinals.get(parentId);
      if (
        currentOrdinal === undefined ||
        parentOrdinal === undefined ||
        parentOrdinal >= currentOrdinal
      )
        throw new Error('Invalid session branch.');
      currentId = parentId;
    }

    type PageEntry = {
      ordinal: number;
      entry: unknown;
      prefixHash: string;
      bytes: number;
    };
    const page: PageEntry[] = [];
    let pageBytes = 0;
    let branchOrdinal = 0;
    let selectedCount = 0;
    let headerInSecondPass = false;
    let reachedUpperBound = false;
    const seenHasher = createHash('sha256');
    const upperBound = cursor?.before;
    const secondPassInput = createReadStream(file, { encoding: 'utf8' });
    const secondPassLines = readline.createInterface({
      input: secondPassInput,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of secondPassLines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 24 * 1024 * 1024)
          throw new Error('A session entry is too large to open remotely.');
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        const isHeader = !headerInSecondPass;
        if (isHeader) {
          headerInSecondPass = true;
          if (!isRecord(parsed) || parsed.type !== 'session')
            throw new Error('Invalid session branch.');
        }
        const entryId = isRecord(parsed) ? parsed.id : undefined;
        const selected =
          isHeader || (typeof entryId === 'string' && branchIds.has(entryId));
        if (
          selected &&
          upperBound !== undefined &&
          branchOrdinal === upperBound
        ) {
          reachedUpperBound = true;
          break;
        }
        const entry = redactImageData(parsed);
        const serialized = JSON.stringify(entry);
        const prefixHash = seenHasher.copy().digest('hex');
        updateHistoryHash(seenHasher, serialized);
        if (!selected) continue;
        const originalBytes = Buffer.byteLength(serialized);
        const outputEntry =
          originalBytes > HISTORY_PAGE_BYTES
            ? {
                type: 'history_omission',
                ...(isRecord(entry) && typeof entry.id === 'string'
                  ? { id: entry.id }
                  : {}),
                ...(isRecord(entry) && typeof entry.type === 'string'
                  ? { originalType: entry.type }
                  : {}),
                reason: 'entry-exceeds-page-budget',
                originalBytes,
              }
            : entry;
        const outputBytes = Buffer.byteLength(JSON.stringify(outputEntry));
        page.push({
          ordinal: branchOrdinal,
          entry: outputEntry,
          prefixHash,
          bytes: outputBytes,
        });
        pageBytes += outputBytes;
        while (pageBytes > HISTORY_PAGE_BYTES && page.length > 0) {
          const shifted = page.shift();
          if (!shifted) break;
          pageBytes -= shifted.bytes;
        }
        branchOrdinal += 1;
        selectedCount += 1;
      }
    } finally {
      secondPassLines.close();
      secondPassInput.destroy();
    }
    if (upperBound !== undefined && branchOrdinal === upperBound)
      reachedUpperBound = true;
    if (
      upperBound !== undefined &&
      (!reachedUpperBound ||
        seenHasher.copy().digest('hex') !== cursor?.prefixHash)
    )
      throw new Error('Stale history cursor.');
    if (upperBound === undefined && selectedCount !== branchIds.size + 1)
      throw new Error('Invalid session branch.');
    const end = upperBound ?? branchOrdinal;
    const start = page[0]?.ordinal ?? end;
    const hasOlder = start > 0;
    const nextBefore = hasOlder
      ? encodeHistoryCursor({
          version: 1,
          sessionId: id,
          file,
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          prefixHash: page[0]?.prefixHash ?? seenHasher.copy().digest('hex'),
          before: start,
          leafId,
        })
      : undefined;
    return {
      metadata,
      entries: page.map((item) => item.entry),
      entriesComplete: cursor === undefined && start === 0,
      history: {
        version: 1,
        start,
        end,
        hasOlder,
        ...(nextBefore === undefined ? {} : { nextBefore }),
      },
    };
  }

  /** Rename a known dormant session by appending a normal Pi session_info entry. */
  async rename(id: string, name: string): Promise<SessionIndexEntry> {
    const indexed = this.files.get(id);
    if (!indexed || !within(path.resolve(this.sessionDir), indexed.file))
      throw new Error('Unknown session.');
    const safeName = validateSessionName(name);
    const entry = {
      type: 'session_info',
      id: randomUUID(),
      parentId: indexed.lastEntryId ?? null,
      timestamp: new Date().toISOString(),
      name: safeName,
    };
    // appendFile uses O_APPEND so one JSONL entry is not overwritten by a
    // concurrent Pi append. Re-index from disk so latest-name semantics apply.
    await fs.appendFile(indexed.file, `${JSON.stringify(entry)}\n`, 'utf8');
    await this.indexFile(indexed.file, this.workspaces);
    const renamed = this.files.get(id);
    if (!renamed) throw new Error('Session disappeared while renaming.');
    const { header: _header, lastEntryId: _lastEntryId, ...metadata } = renamed;
    return metadata;
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.watcherRetry) clearTimeout(this.watcherRetry);
    this.watcherRetry = undefined;
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
  }

  private async ensureWatcher(): Promise<void> {
    if (this.watcher) return;
    try {
      const fsModule = await import('node:fs');
      this.watcher = fsModule.watch(
        this.sessionDir,
        { recursive: true },
        (_event, filename) => {
          if (!filename) {
            void this.rebuild(this.workspaces)
              .then(() => this.notifyChange())
              .catch(() => undefined);
            return;
          }
          const file = path.resolve(this.sessionDir, String(filename));
          if (file.endsWith('.jsonl')) this.scheduleIndex(file);
          else
            void this.rebuild(this.workspaces)
              .then(() => this.notifyChange())
              .catch(() => undefined);
        },
      );
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
        this.scheduleWatcherRetry();
      });
    } catch {
      // The session directory may not exist yet, or the platform may not
      // support recursive fs.watch. Retry so a later-created directory works.
      this.scheduleWatcherRetry();
    }
  }

  private notifyChange(): void {
    try {
      this.onChange?.();
    } catch {
      // Filesystem observation must never fail because a downstream listener
      // is temporarily unavailable.
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.watcherRetry) return;
    this.watcherRetry = setTimeout(() => {
      this.watcherRetry = undefined;
      void this.ensureWatcher();
    }, 1_000);
    this.watcherRetry.unref?.();
  }

  private scheduleIndex(file: string): void {
    const existing = this.scheduled.get(file);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.scheduled.delete(file);
      const previous = this.indexing.get(file) ?? Promise.resolve();
      const next = previous
        .then(() => this.indexFile(file, this.workspaces))
        .catch(() => this.removeFile(file))
        .then(() => this.notifyChange())
        .finally(() => {
          if (this.indexing.get(file) === next) this.indexing.delete(file);
        });
      this.indexing.set(file, next);
    }, 50);
    timer.unref?.();
    this.scheduled.set(file, timer);
  }

  private async findJsonl(directory: string): Promise<string[]> {
    const result: string[] = [];
    let children: import('node:fs').Dirent[] = [];
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (child.isDirectory()) result.push(...(await this.findJsonl(file)));
      else if (child.isFile() && child.name.endsWith('.jsonl'))
        result.push(file);
    }
    return result;
  }

  private idForPath(file: string): string {
    return path.basename(file, '.jsonl');
  }

  private async indexFile(
    file: string,
    workspaces: readonly WorkspaceTarget[],
  ): Promise<void> {
    const root = path.resolve(this.sessionDir);
    const resolved = path.resolve(file);
    if (!within(root, resolved) || !resolved.endsWith('.jsonl')) return;
    try {
      const input = createReadStream(resolved, { encoding: 'utf8' });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      let header: Record<string, unknown> | undefined;
      let name: string | undefined;
      let sawSessionInfo = false;
      let firstUserEntry: unknown;
      let lastEntryId: string | undefined;
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            // A partial final write must not erase an otherwise valid session.
            continue;
          }
          if (!header) {
            if (!isRecord(parsed) || parsed.type !== 'session')
              return this.removeFile(resolved);
            header = parsed;
            continue;
          }
          if (!isRecord(parsed)) continue;
          if (typeof parsed.id === 'string') lastEntryId = parsed.id;
          if (parsed.type === 'session_info') {
            sawSessionInfo = true;
            name =
              typeof parsed.name === 'string'
                ? parsed.name.trim() || undefined
                : undefined;
          }
          if (
            firstUserEntry === undefined &&
            parsed.type === 'message' &&
            isRecord(parsed.message) &&
            parsed.message.role === 'user'
          ) {
            firstUserEntry = parsed;
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
      if (!header || typeof header.cwd !== 'string')
        return this.removeFile(resolved);
      const stat = await fs.stat(resolved);
      const id =
        typeof header.id === 'string' ? header.id : this.idForPath(resolved);
      const previous = this.files.get(id);
      if (previous && previous.file !== resolved)
        this.fileIds.delete(previous.file);
      const entry: IndexedFile = {
        id,
        file: resolved,
        cwd: header.cwd,
        workspaceId: workspaceFor(header.cwd, workspaces),
        ...(sawSessionInfo && name ? { name } : {}),
        title: deriveSessionTitle(
          firstUserEntry === undefined ? [] : [firstUserEntry],
        ),
        updatedAt: stat.mtimeMs,
        header,
        lastEntryId,
      };
      this.files.set(id, entry);
      this.fileIds.set(resolved, id);
      this.metadata?.saveSession(entry);
    } catch (error) {
      this.removeFile(resolved);
      throw error;
    }
  }

  private removeFile(file: string): void {
    const resolved = path.resolve(file);
    const id = this.fileIds.get(resolved);
    this.fileIds.delete(resolved);
    if (id && this.files.get(id)?.file === resolved) this.files.delete(id);
  }
}
