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

export interface SessionReadOptions {
  /** Resolve the active leaf from the latest valid entry in the file. */
  resolveLatestLeaf?: boolean;
}

export interface SelectedBranchEntryProjection {
  /** The bounded entry retained by the selected-branch scan. */
  entry: unknown;
  /** Whether the projector omitted data from the selected entry. */
  truncated?: boolean;
  /** In-memory size of non-serialized projection data, such as a detail view. */
  retainedBytes?: number;
}

export type SelectedBranchEntryProjector = (
  entry: unknown,
) => SelectedBranchEntryProjection;

export interface SelectedBranchReadOptions extends SessionReadOptions {
  /** Project selected entries before they are retained in the page. */
  projectEntry?: SelectedBranchEntryProjector;
}

export interface SelectedBranchReadResult {
  metadata: SessionIndexEntry;
  /** Candidate entries only; non-candidate transcript entries are never retained. */
  entries: unknown[];
  leafId?: string;
  entriesTruncated: boolean;
}

export type SelectedBranchEntrySelector = (entry: unknown) => boolean;

const MAX_SELECTED_BRANCH_ENTRIES = 2_048;
const MAX_SELECTED_BRANCH_BYTES = 8 * 1024 * 1024;
const MAX_SELECTED_BRANCH_ENTRY_BYTES = 512 * 1024;

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

// Keep ordinary transcript pages below the transport envelope limit. Delegate
// history uses its own projection budget below and is intentionally unchanged.
const HISTORY_PAGE_BYTES = 384 * 1024;
const LATEST_LEAF_READ_ATTEMPTS = 3;

type SessionFileVersion = {
  dev: number;
  ino: number;
  size: number;
};

class SessionFileChangedError extends Error {
  constructor() {
    super('Session file changed while resolving its latest branch.');
  }
}

function sameSessionFileVersion(
  left: SessionFileVersion,
  right: SessionFileVersion,
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.size === right.size
  );
}

async function verifySessionFileVersion(
  file: string,
  expected: SessionFileVersion,
): Promise<void> {
  const current = await fs.stat(file).catch(() => undefined);
  if (!current || !sameSessionFileVersion(expected, current))
    throw new SessionFileChangedError();
}

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
  private readonly watchers = new Map<
    string,
    ReturnType<typeof import('node:fs').watch>
  >();
  private readonly watcherRetries = new Map<string, NodeJS.Timeout>();
  private readonly scheduled = new Map<string, NodeJS.Timeout>();
  private readonly indexing = new Map<string, Promise<void>>();
  private workspaces: readonly WorkspaceTarget[] = [];
  constructor(
    private readonly sessionDir: string,
    private readonly metadata?: MetadataStore,
    private readonly onChange?: (
      sessionId?: string,
      auxiliary?: boolean,
    ) => void,
    private readonly auxiliarySessionDir?: string,
  ) {}

  async rebuild(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    this.files.clear();
    this.fileIds.clear();
    const paths = (
      await Promise.all(this.sessionRoots().map((root) => this.findJsonl(root)))
    ).flat();
    for (const file of paths)
      await this.indexFile(file, this.workspaces).catch(() => undefined);
  }

  async start(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    await this.rebuild(this.workspaces);
    await Promise.all(
      this.sessionRoots().map((root) => this.ensureWatcher(root)),
    );
  }

  async refresh(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    await this.rebuild(this.workspaces);
  }

  list(workspaceId?: string): SessionIndexEntry[] {
    return [...this.files.values()]
      .filter((file) => !this.isAuxiliaryFile(file.file))
      .filter((file) => !workspaceId || file.workspaceId === workspaceId)
      .map(({ header: _header, lastEntryId: _lastEntryId, ...entry }) => entry)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SessionIndexEntry | undefined {
    const entry = this.files.get(id);
    return entry ? this.publicEntry(entry) : undefined;
  }

  isAuxiliary(id: string): boolean {
    const entry = this.files.get(id);
    return entry ? this.isAuxiliaryFile(entry.file) : false;
  }

  // TODO: switch older pages to reverse-file reads if page counts grow; the
  // bounded streaming scan keeps current history sizes simple and safe.
  async readEntries(
    id: string,
    before?: string,
    leafId?: string,
    options: SessionReadOptions = {},
  ): Promise<{
    metadata: SessionIndexEntry;
    entries: unknown[];
    entriesComplete: boolean;
    history: SessionHistoryPage;
  }> {
    const indexed = this.files.get(id);
    if (!indexed || !(await this.isSafeSessionFile(indexed.file)))
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
    const metadata = this.publicEntry(indexed);
    if (requestedLeafId !== undefined || options.resolveLatestLeaf) {
      const resolveLatestLeaf =
        options.resolveLatestLeaf === true && requestedLeafId === undefined;
      const publicBranchResult = (
        result: Awaited<ReturnType<SessionIndex['readBranchEntries']>>,
      ) => {
        const {
          leafId: _leafId,
          entriesTruncated: _entriesTruncated,
          ...response
        } = result;
        return response;
      };
      if (!resolveLatestLeaf)
        return publicBranchResult(
          await this.readBranchEntries(
            id,
            indexed.file,
            stat,
            metadata,
            requestedLeafId,
            cursor,
            false,
          ),
        );
      let latestStat = stat;
      for (let attempt = 0; attempt < LATEST_LEAF_READ_ATTEMPTS; attempt += 1) {
        try {
          return publicBranchResult(
            await this.readBranchEntries(
              id,
              indexed.file,
              latestStat,
              metadata,
              undefined,
              cursor,
              true,
            ),
          );
        } catch (error) {
          if (
            !(error instanceof SessionFileChangedError) ||
            attempt === LATEST_LEAF_READ_ATTEMPTS - 1
          )
            throw error;
          const refreshed = await fs.stat(indexed.file).catch(() => undefined);
          if (!refreshed) throw new Error('Unknown session.');
          latestStat = refreshed;
        }
      }
      throw new Error('Unable to resolve the latest session branch.');
    }
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
          // Omission markers are tiny, but their source entry still consumes a
          // page slot so a multi-megabyte history remains pageable.
          const budgetBytes = Math.min(originalBytes, HISTORY_PAGE_BYTES);
          page.push({
            ordinal,
            entry: outputEntry,
            prefixHash,
            bytes: budgetBytes,
          });
          pageBytes += budgetBytes;
          while (pageBytes > HISTORY_PAGE_BYTES && page.length > 1) {
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
   * Scan one selected branch while retaining only entries matching the
   * server-internal selector. The ancestry pass still validates every branch
   * identity, but transcript payloads outside the selector never accumulate.
   */
  async readSelectedBranchEntries(
    id: string,
    leafId: string | undefined,
    selector: SelectedBranchEntrySelector,
    options: SelectedBranchReadOptions = {},
  ): Promise<SelectedBranchReadResult> {
    const indexed = this.files.get(id);
    if (!indexed || !(await this.isSafeSessionFile(indexed.file)))
      throw new Error('Unknown session.');
    const stat = await fs.stat(indexed.file).catch(() => undefined);
    if (!stat) throw new Error('Unknown session.');
    const metadata = this.publicEntry(indexed);
    let latestStat = stat;
    for (let attempt = 0; attempt < LATEST_LEAF_READ_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.readBranchEntries(
          id,
          indexed.file,
          latestStat,
          metadata,
          leafId,
          undefined,
          options.resolveLatestLeaf === true && leafId === undefined,
          selector,
          options.projectEntry,
        );
        return {
          metadata: result.metadata,
          entries: result.entries,
          ...(result.leafId === undefined ? {} : { leafId: result.leafId }),
          entriesTruncated: result.entriesTruncated,
        };
      } catch (error) {
        if (
          !(error instanceof SessionFileChangedError) ||
          attempt === LATEST_LEAF_READ_ATTEMPTS - 1
        )
          throw error;
        const refreshed = await fs.stat(indexed.file).catch(() => undefined);
        if (!refreshed) throw new Error('Unknown session.');
        latestStat = refreshed;
      }
    }
    throw new Error('Unable to resolve the latest session branch.');
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
    leafId: string | undefined,
    cursor: HistoryCursor | undefined,
    resolveLatestLeaf: boolean,
    selector?: SelectedBranchEntrySelector,
    projectEntry?: SelectedBranchEntryProjector,
  ): Promise<{
    metadata: SessionIndexEntry;
    entries: unknown[];
    entriesComplete: boolean;
    history: SessionHistoryPage;
    leafId?: string;
    entriesTruncated: boolean;
  }> {
    const parents = new Map<string, unknown>();
    const ordinals = new Map<string, number>();
    let headerSeen = false;
    let latestEntryId: string | undefined;
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
          latestEntryId = parsed.id;
        }
        sourceOrdinal += 1;
      }
    } finally {
      firstPassLines.close();
      firstPassInput.destroy();
    }
    // The first pass chooses the leaf and the second pass materializes its
    // ancestry. A concurrent append between them must force a fresh leaf
    // resolution rather than returning a page for the old file version.
    if (resolveLatestLeaf) await verifySessionFileVersion(file, stat);
    const resolvedLeafId = resolveLatestLeaf ? latestEntryId : leafId;
    if (!headerSeen) throw new Error('Invalid session branch.');

    const branchIds = new Set<string>();
    if (resolvedLeafId === undefined) {
      // A valid session may contain only its header so far. There is no
      // ancestry to select in that case, and its delegate history is empty.
      if (parents.size > 0) throw new Error('Invalid session branch.');
    } else {
      if (!parents.has(resolvedLeafId))
        throw new Error('Invalid session branch.');
      let currentId = resolvedLeafId;
      while (true) {
        if (branchIds.has(currentId))
          throw new Error('Invalid session branch.');
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
    let entriesTruncated = false;
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
        const outputOrdinal = branchOrdinal;
        const candidate = selector === undefined || selector(entry);
        branchOrdinal += 1;
        selectedCount += 1;
        if (!candidate) continue;
        const projection = projectEntry?.(entry);
        const outputEntry = projection?.entry ?? entry;
        const outputSerialized = JSON.stringify(outputEntry);
        const outputEntryBytes = Buffer.byteLength(outputSerialized);
        const retainedBytes = projection?.retainedBytes ?? outputEntryBytes;
        if (
          selector !== undefined &&
          (retainedBytes > MAX_SELECTED_BRANCH_ENTRY_BYTES ||
            page.length >= MAX_SELECTED_BRANCH_ENTRIES ||
            pageBytes + retainedBytes > MAX_SELECTED_BRANCH_BYTES)
        ) {
          entriesTruncated = true;
          continue;
        }
        if (projection?.truncated === true) entriesTruncated = true;
        const output =
          outputEntryBytes > HISTORY_PAGE_BYTES
            ? {
                type: 'history_omission',
                ...(isRecord(outputEntry) && typeof outputEntry.id === 'string'
                  ? { id: outputEntry.id }
                  : {}),
                ...(isRecord(outputEntry) &&
                typeof outputEntry.type === 'string'
                  ? { originalType: outputEntry.type }
                  : {}),
                reason: 'entry-exceeds-page-budget',
                originalBytes: outputEntryBytes,
              }
            : outputEntry;
        const pageBudgetBytes =
          selector === undefined
            ? Math.min(Buffer.byteLength(serialized), HISTORY_PAGE_BYTES)
            : retainedBytes;
        page.push({
          ordinal: outputOrdinal,
          entry: output,
          prefixHash,
          bytes: pageBudgetBytes,
        });
        pageBytes += pageBudgetBytes;
        while (
          selector === undefined &&
          pageBytes > HISTORY_PAGE_BYTES &&
          page.length > 1
        ) {
          const shifted = page.shift();
          if (!shifted) break;
          pageBytes -= shifted.bytes;
        }
      }
    } finally {
      secondPassLines.close();
      secondPassInput.destroy();
    }
    if (resolveLatestLeaf) await verifySessionFileVersion(file, stat);
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
          leafId: resolvedLeafId,
        })
      : undefined;
    return {
      metadata,
      entries: page.map((item) => item.entry),
      entriesComplete: cursor === undefined && start === 0,
      ...(resolvedLeafId === undefined ? {} : { leafId: resolvedLeafId }),
      entriesTruncated,
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
    if (!indexed || !(await this.isSafeSessionFile(indexed.file)))
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
    return this.publicEntry(renamed);
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const retry of this.watcherRetries.values()) clearTimeout(retry);
    this.watcherRetries.clear();
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
  }

  private sessionRoots(): string[] {
    const roots = [path.resolve(this.sessionDir)];
    if (this.auxiliarySessionDir) {
      const auxiliary = path.resolve(this.auxiliarySessionDir);
      if (!roots.includes(auxiliary)) roots.push(auxiliary);
    }
    return roots;
  }

  private isAuxiliaryFile(file: string): boolean {
    return Boolean(
      this.auxiliarySessionDir &&
        within(path.resolve(this.auxiliarySessionDir), path.resolve(file)),
    );
  }

  private publicEntry(entry: IndexedFile): SessionIndexEntry {
    const {
      header: _header,
      lastEntryId: _lastEntryId,
      ...publicEntry
    } = entry;
    return this.isAuxiliaryFile(entry.file)
      ? { ...publicEntry, file: '' }
      : publicEntry;
  }

  private async isSafeSessionFile(file: string): Promise<boolean> {
    const resolved = path.resolve(file);
    const root = this.sessionRoots().find((candidate) =>
      within(candidate, resolved),
    );
    if (!root) return false;
    try {
      const [rootStat, fileStat, realRoot, realFile] = await Promise.all([
        fs.lstat(root),
        fs.lstat(resolved),
        fs.realpath(root),
        fs.realpath(resolved),
      ]);
      return (
        rootStat.isDirectory() &&
        !rootStat.isSymbolicLink() &&
        fileStat.isFile() &&
        !fileStat.isSymbolicLink() &&
        within(realRoot, realFile)
      );
    } catch {
      return false;
    }
  }

  private async ensureWatcher(root: string): Promise<void> {
    if (this.watchers.has(root)) return;
    try {
      const fsModule = await import('node:fs');
      const watcher = fsModule.watch(
        root,
        { recursive: true },
        (_event, filename) => this.handleWatcherEvent(root, filename),
      );
      this.watchers.set(root, watcher);
      watcher.on('error', () => {
        watcher.close();
        this.watchers.delete(root);
        this.scheduleWatcherRetry(root);
      });
    } catch {
      // A root may not exist yet. Retry so later delegate/session creation is observed.
      this.scheduleWatcherRetry(root);
    }
  }

  private handleWatcherEvent(
    root: string,
    filename: string | Buffer | null | undefined,
  ): void {
    if (!filename) {
      void this.rebuild(this.workspaces)
        .then(() => this.notifyChange())
        .catch(() => undefined);
      return;
    }
    const file = path.resolve(root, String(filename));
    if (file.endsWith('.jsonl')) {
      this.scheduleIndex(file);
      return;
    }
    // Auxiliary roots contain delegate sidecars and atomic-write scratch files.
    // They are not catalogue inputs; only their JSONL transcript triggers an
    // incremental index update. Normal roots retain the fallback rebuild.
    if (this.isAuxiliaryFile(file)) return;
    void this.rebuild(this.workspaces)
      .then(() => this.notifyChange())
      .catch(() => undefined);
  }

  private notifyChange(sessionId?: string, auxiliary?: boolean): void {
    try {
      this.onChange?.(sessionId, auxiliary);
    } catch {
      // Filesystem observation must never fail because a downstream listener
      // is temporarily unavailable.
    }
  }

  private scheduleWatcherRetry(root: string): void {
    if (this.watcherRetries.has(root)) return;
    const retry = setTimeout(() => {
      this.watcherRetries.delete(root);
      void this.ensureWatcher(root);
    }, 1_000);
    retry.unref?.();
    this.watcherRetries.set(root, retry);
  }

  private scheduleIndex(file: string): void {
    const existing = this.scheduled.get(file);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.scheduled.delete(file);
      const previous = this.indexing.get(file) ?? Promise.resolve();
      const previousId = this.fileIds.get(path.resolve(file));
      const next = previous
        .then(() => this.indexFile(file, this.workspaces))
        .catch(() => this.removeFile(file))
        .then(() =>
          this.notifyChange(
            this.fileIds.get(path.resolve(file)) ?? previousId,
            this.isAuxiliaryFile(file),
          ),
        )
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
    const resolved = path.resolve(file);
    if (
      !resolved.endsWith('.jsonl') ||
      !(await this.isSafeSessionFile(resolved))
    )
      return this.removeFile(resolved);
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
      if (previous && previous.file !== resolved) {
        // Normal sessions win the practically-impossible ID collision without
        // making an auxiliary delegate path browser-visible.
        if (
          !this.isAuxiliaryFile(previous.file) &&
          this.isAuxiliaryFile(resolved)
        )
          return;
        this.fileIds.delete(previous.file);
      }
      const entry: IndexedFile = {
        id,
        file: resolved,
        cwd: header.cwd,
        workspaceId: workspaceFor(header.cwd, workspaces),
        ...(sawSessionInfo && name ? { name } : {}),
        title: deriveSessionTitle(
          firstUserEntry === undefined ? [] : [firstUserEntry],
        ),
        startedAt:
          typeof header.timestamp === 'string' &&
          Number.isFinite(Date.parse(header.timestamp))
            ? Date.parse(header.timestamp)
            : stat.birthtimeMs,
        updatedAt: stat.mtimeMs,
        header,
        lastEntryId,
      };
      this.files.set(id, entry);
      this.fileIds.set(resolved, id);
      if (!this.isAuxiliaryFile(resolved)) this.metadata?.saveSession(entry);
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
