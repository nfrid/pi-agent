import { createHash, randomUUID } from 'node:crypto';
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
}

const HISTORY_PAGE_BYTES = 8 * 1024 * 1024;

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
      decoded.before <= 0
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

  async readEntries(
    id: string,
    before?: string,
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
    if (
      cursor &&
      (cursor.sessionId !== id ||
        cursor.file !== indexed.file ||
        cursor.dev !== stat.dev ||
        cursor.ino !== stat.ino ||
        stat.size < cursor.size)
    )
      throw new Error('Stale history cursor.');
    const upperBound = cursor?.before;
    const { header: _header, lastEntryId: _lastEntryId, ...metadata } = indexed;
    const allEntries: { ordinal: number; entry: unknown; bytes: number }[] = [];
    let ordinal = 0;
    const prefixHasher = createHash('sha256');
    let prefixHash: string | undefined;
    const input = createReadStream(indexed.file, { encoding: 'utf8' });
    const lines = readline.createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 24 * 1024 * 1024)
          throw new Error('A session entry is too large to open remotely.');
        try {
          const entry = redactImageData(JSON.parse(line) as unknown);
          const serialized = JSON.stringify(entry);
          const bytes = Buffer.byteLength(serialized);
          if (upperBound !== undefined && ordinal === upperBound)
            prefixHash = prefixHasher.copy().digest('hex');
          prefixHasher.update(serialized);
          allEntries.push({ ordinal, entry, bytes });
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
    if (upperBound !== undefined && upperBound === ordinal)
      prefixHash = prefixHasher.copy().digest('hex');
    if (
      upperBound !== undefined &&
      (upperBound > ordinal || prefixHash !== cursor?.prefixHash)
    )
      throw new Error('Stale history cursor.');
    const end = upperBound ?? ordinal;
    const page: { ordinal: number; entry: unknown; bytes: number }[] = [];
    let responseBytes = 0;
    let entriesComplete = true;
    for (const item of allEntries) {
      if (item.ordinal >= end) break;
      page.push(item);
      responseBytes += item.bytes;
      while (responseBytes > HISTORY_PAGE_BYTES && page.length > 0) {
        entriesComplete = false;
        responseBytes -= page.shift()?.bytes ?? 0;
      }
    }
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
          prefixHash: createHash('sha256')
            .update(
              allEntries
                .filter((item) => item.ordinal < start)
                .map((item) => JSON.stringify(item.entry))
                .join(''),
            )
            .digest('hex'),
          before: start,
        })
      : undefined;
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
