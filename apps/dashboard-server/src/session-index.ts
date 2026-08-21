import { createHash, type Hash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import {
  type ActivityGroup,
  activityEntryFromRaw,
  groupTranscript,
  owningActivityGroup,
  type TranscriptEntry,
} from '@pi-dashboard/activity-model';
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

interface SessionLineDescriptor {
  /** Logical ordinal among valid, non-empty JSONL entries. */
  readonly ordinal: number;
  /** Physical UTF-8 byte boundaries, including the line ending at `end`. */
  readonly start: number;
  readonly end: number;
  /** Size used by the redacted history transport budget. */
  readonly outputBytes: number;
  /** SHA-256 of the exact physical bytes before this descriptor. */
  readonly prefixHash: string;
  readonly id?: string;
  readonly parentId?: unknown;
  readonly type?: string;
  readonly resume?: {
    readonly model?: { readonly provider: string; readonly model: string };
    readonly thinking?: string;
    readonly contextTokens?: number;
  };
  readonly activity: TranscriptEntry;
}

interface SessionHistoryIndex {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly fileHash: string;
  /** Hashes at every physical line boundary, including the file end. */
  readonly prefixHashes: ReadonlyMap<number, string>;
  readonly descriptors: readonly SessionLineDescriptor[];
  readonly byId: ReadonlyMap<string, SessionLineDescriptor>;
  readonly latestEntryId?: string;
  readonly groups: readonly ActivityGroup[];
}

interface IndexedFile extends SessionIndexEntry {
  header: Record<string, unknown>;
  lastEntryId?: string;
  historyIndex: SessionHistoryIndex;
}

export interface SessionHistoryPage {
  version: 1;
  start: number;
  end: number;
  hasOlder: boolean;
  nextBefore?: string;
  /** The leading activity group could not be extended within hard caps. */
  leadingContinuation?: boolean;
}

export interface SessionEntriesResult {
  metadata: SessionIndexEntry;
  entries: unknown[];
  entriesComplete: boolean;
  history: SessionHistoryPage;
  sourceCursor?: AuxiliarySourceCursor;
}

interface AuxiliarySourceMetadata {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface AuxiliaryAppendState {
  readonly cursorKey: string;
  readonly generation: number;
  readonly hash: Hash;
  readonly source: AuxiliarySourceMetadata;
}

export interface AuxiliarySourceCursor {
  /** Cursor format is server-internal and intentionally opaque to browsers. */
  version: 1;
  dev: number;
  ino: number;
  /** Number of complete, non-empty JSONL lines through byteOffset (malformed lines included). */
  ordinal: number;
  /** Exact UTF-8 byte offset at the end of the last complete line. */
  byteOffset: number;
  /** SHA-256 of the exact bytes in [0, byteOffset). */
  prefixHash: string;
}

export type AuxiliaryAppendResetReason =
  | 'source-rewrite'
  | 'source-truncated'
  | 'source-replaced'
  | 'source-malformed'
  | 'entry-too-large';

export class AuxiliaryAppendError extends Error {
  readonly reason: AuxiliaryAppendResetReason;

  constructor(reason: AuxiliaryAppendResetReason, message: string = reason) {
    super(message);
    this.name = 'AuxiliaryAppendError';
    this.reason = reason;
  }
}

export interface AuxiliaryAppendRange {
  readonly records: readonly unknown[];
  readonly nextCursor: AuxiliarySourceCursor;
  /** More complete records or a partial final line remain after nextCursor. */
  readonly hasMore: boolean;
}

export interface SessionReadOptions {
  /** Resolve the active leaf from the latest valid entry in the file. */
  resolveLatestLeaf?: boolean;
  /** Read an auxiliary snapshot at this exact source cut. Server-internal. */
  sourceCursor?: AuxiliarySourceCursor;
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

/** Browser-visible history cursors are opaque, but their proof is strict. */
interface HistoryCursorV2 {
  version: 2;
  sessionId: string;
  file: string;
  dev: number;
  ino: number;
  indexedSize: number;
  selectedOrdinal: number;
  selectedByteOffset: number;
  prefixHash: string;
  fileHash: string;
  leafId?: string;
}

// Keep ordinary transcript pages below the transport envelope limit. Delegate
// history uses its own projection budget below and is intentionally unchanged.
export const HISTORY_PAGE_BYTES = 384 * 1024;
export const HISTORY_PAGE_ENTRIES = 256;
/** Extra backward extension reserved for the owning activity group. */
export const HISTORY_OVERSCAN_BYTES = 128 * 1024;
export const HISTORY_OVERSCAN_ENTRIES = 64;
export const INDEX_SCAN_CHUNK_BYTES = 64 * 1024;
export const INDEX_MAX_LINE_BYTES = 32 * 1024 * 1024;
const LATEST_LEAF_READ_ATTEMPTS = 3;
/** A single source line must leave room for its normalized protocol envelope. */
const AUXILIARY_ENTRY_BYTES = 384 * 1024;
/** Range reads are deliberately smaller than a history page and repeatable. */
const AUXILIARY_RANGE_BYTES = 256 * 1024;
const AUXILIARY_RANGE_RECORDS = 256;
const AUXILIARY_SEED_PARTIAL_BYTES = 24 * 1024 * 1024;
const EMPTY_PREFIX_HASH = createHash('sha256').digest('hex');

function isJsonlWhitespaceByte(byte: number): boolean {
  return (
    byte === 0x09 ||
    byte === 0x0b ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x20
  );
}

function isBlankJsonlLine(line: Uint8Array): boolean {
  for (const byte of line) if (!isJsonlWhitespaceByte(byte)) return false;
  return true;
}

function cursorKey(cursor: AuxiliarySourceCursor): string {
  return `${cursor.version}:${cursor.dev}:${cursor.ino}:${cursor.ordinal}:${cursor.byteOffset}:${cursor.prefixHash}`;
}

function auxiliarySourceMetadata(
  stat: import('node:fs').Stats,
): AuxiliarySourceMetadata {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameAuxiliarySourceMetadata(
  left: AuxiliarySourceMetadata,
  right: import('node:fs').Stats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

type AuxiliaryFileHandle = Awaited<ReturnType<typeof fs.open>>;

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
  allowGrowth = false,
): Promise<void> {
  const current = await fs.stat(file).catch(() => undefined);
  if (
    !current ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    (allowGrowth
      ? current.size < expected.size
      : !sameSessionFileVersion(expected, current))
  )
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

function encodeHistoryCursorV2(cursor: HistoryCursorV2): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeHistoryCursorV2(value: string): HistoryCursorV2 {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length > 4096 ||
    Buffer.from(value, 'base64url').toString('base64url') !== value
  )
    throw new Error('Invalid history cursor.');
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as unknown;
    if (!isRecord(decoded) || Array.isArray(decoded)) throw new Error();
    const allowed = new Set([
      'version',
      'sessionId',
      'file',
      'dev',
      'ino',
      'indexedSize',
      'selectedOrdinal',
      'selectedByteOffset',
      'prefixHash',
      'fileHash',
      'leafId',
    ]);
    if (Object.keys(decoded).some((key) => !allowed.has(key)))
      throw new Error();
    const nonnegativeSafeInt = (key: string): boolean =>
      typeof decoded[key] === 'number' &&
      Number.isSafeInteger(decoded[key]) &&
      decoded[key] >= 0;
    if (
      decoded.version !== 2 ||
      typeof decoded.sessionId !== 'string' ||
      decoded.sessionId.length === 0 ||
      typeof decoded.file !== 'string' ||
      decoded.file.length === 0 ||
      !nonnegativeSafeInt('dev') ||
      !nonnegativeSafeInt('ino') ||
      !nonnegativeSafeInt('indexedSize') ||
      !nonnegativeSafeInt('selectedOrdinal') ||
      !nonnegativeSafeInt('selectedByteOffset') ||
      typeof decoded.prefixHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(decoded.prefixHash) ||
      typeof decoded.fileHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(decoded.fileHash) ||
      (decoded.leafId !== undefined &&
        (typeof decoded.leafId !== 'string' || decoded.leafId.length === 0))
    )
      throw new Error();
    return decoded as unknown as HistoryCursorV2;
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

function resumeFromRawEntry(value: unknown): SessionLineDescriptor['resume'] {
  if (!isRecord(value)) return undefined;
  if (value.type === 'model_change') {
    const provider = value.provider;
    const model = value.modelId;
    return typeof provider === 'string' && typeof model === 'string'
      ? { model: { provider, model } }
      : undefined;
  }
  if (value.type === 'thinking_level_change') {
    return typeof value.thinkingLevel === 'string'
      ? { thinking: value.thinkingLevel }
      : undefined;
  }
  if (value.type !== 'message' || !isRecord(value.message)) return undefined;
  if (value.message.role !== 'assistant') return undefined;
  const provider = value.message.provider;
  const model = value.message.model;
  const usage = isRecord(value.message.usage) ? value.message.usage : undefined;
  const totalTokens = usage?.totalTokens;
  return {
    ...(typeof provider === 'string' && typeof model === 'string'
      ? { model: { provider, model } }
      : {}),
    ...(typeof totalTokens === 'number' &&
    Number.isFinite(totalTokens) &&
    totalTokens >= 0
      ? { contextTokens: totalTokens }
      : {}),
  };
}

function branchPageDescriptors(
  index: SessionHistoryIndex,
  leafId: string | undefined,
): { descriptors: SessionLineDescriptor[]; leafId?: string } {
  const all = [...index.descriptors];
  if (leafId === undefined) {
    if (all.length !== 1) throw new Error('Invalid session branch.');
    return { descriptors: all };
  }
  const byId = new Map<string, SessionLineDescriptor>();
  for (const descriptor of all) {
    if (!descriptor.id) continue;
    if (byId.has(descriptor.id)) throw new Error('Invalid session branch.');
    byId.set(descriptor.id, descriptor);
  }
  const leaf = byId.get(leafId);
  if (!leaf) throw new Error('Invalid session branch.');
  const selected = new Set<string>();
  let current = leaf;
  while (true) {
    if (!current.id || selected.has(current.id))
      throw new Error('Invalid session branch.');
    selected.add(current.id);
    const parentId = current.parentId;
    if (parentId === undefined || parentId === null) break;
    if (typeof parentId !== 'string')
      throw new Error('Invalid session branch.');
    const parent = byId.get(parentId);
    if (!parent || parent.ordinal >= current.ordinal)
      throw new Error('Invalid session branch.');
    current = parent;
  }
  const descriptors = all.filter(
    (descriptor) =>
      descriptor.ordinal === 0 ||
      (descriptor.id !== undefined && selected.has(descriptor.id)),
  );
  if (descriptors.length === 0 || descriptors[0]?.ordinal !== 0)
    throw new Error('Invalid session branch.');
  return { descriptors, leafId };
}

function resumeMetadataFromDescriptors(
  index: SessionHistoryIndex,
  leafId: string | undefined,
): Pick<
  SessionIndexEntry,
  'lastKnownModel' | 'lastKnownThinking' | 'lastKnownContextTokens'
> {
  if (!leafId) return {};
  try {
    const descriptors = branchPageDescriptors(index, leafId).descriptors;
    const result: Pick<
      SessionIndexEntry,
      'lastKnownModel' | 'lastKnownThinking' | 'lastKnownContextTokens'
    > = {};
    for (const descriptor of descriptors) {
      if (descriptor.resume?.model)
        result.lastKnownModel = descriptor.resume.model;
      if (descriptor.resume?.thinking)
        result.lastKnownThinking = descriptor.resume.thinking;
      if (descriptor.resume?.contextTokens !== undefined)
        result.lastKnownContextTokens = descriptor.resume.contextTokens;
    }
    return result;
  } catch {
    return {};
  }
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
  private readonly appendStates = new Map<string, AuxiliaryAppendState>();
  private readonly appendGenerations = new Map<string, number>();
  private workspaces: readonly WorkspaceTarget[] = [];
  private historyReadBytesTotal = 0;
  constructor(
    private readonly sessionDir: string,
    private readonly metadata?: MetadataStore,
    private readonly onChange?: (
      sessionId?: string,
      auxiliary?: boolean,
    ) => void,
    private readonly auxiliarySessionDir?: string,
    private readonly onHistoryReadBytes?: (bytes: number) => void,
    private readonly onIndexPendingBytes?: (bytes: number) => void,
  ) {}

  /** Bytes read by indexed history pages; useful for bounded-read diagnostics. */
  get historyReadBytes(): number {
    return this.historyReadBytesTotal;
  }

  resetHistoryReadBytes(): void {
    this.historyReadBytesTotal = 0;
  }

  async rebuild(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    this.files.clear();
    this.fileIds.clear();
    this.appendStates.clear();
    this.appendGenerations.clear();
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
      .map(
        ({
          header: _header,
          lastEntryId: _lastEntryId,
          historyIndex: _historyIndex,
          ...entry
        }) => entry,
      )
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

  /**
   * Return the exact source cut at the end of the currently complete JSONL
   * input. This is used to seed an auxiliary snapshot; it never retains the
   * transcript and intentionally leaves a partial final line unconsumed.
   */
  async readAppendCursor(id: string): Promise<AuxiliarySourceCursor> {
    const result = await this.scanAuxiliaryAppend(id, undefined, {
      collect: false,
      enforceEntrySize: false,
      tolerateMalformed: true,
    });
    return result.nextCursor;
  }

  /**
   * Read a bounded append range from the durable auxiliary JSONL source.
   * Prefix identity is validated before reading, and the final partial line
   * remains at the input cursor for a later completion retry.
   */
  async readAppendRange(
    id: string,
    cursor?: AuxiliarySourceCursor,
  ): Promise<AuxiliaryAppendRange> {
    return this.scanAuxiliaryAppend(id, cursor, { collect: true });
  }

  private async auxiliaryFile(id: string): Promise<{
    indexed: IndexedFile;
    file: string;
  }> {
    const indexed = this.files.get(id);
    if (
      !indexed ||
      !this.isAuxiliaryFile(indexed.file) ||
      !(await this.isSafeSessionFile(indexed.file))
    )
      throw new AuxiliaryAppendError(
        'source-rewrite',
        'Unknown auxiliary session.',
      );
    const stat = await fs.stat(indexed.file).catch(() => undefined);
    if (!stat)
      throw new AuxiliaryAppendError(
        'source-truncated',
        'Auxiliary session disappeared.',
      );
    return { indexed, file: indexed.file };
  }

  private async validateAuxiliaryCursor(
    file: string,
    stat: import('node:fs').Stats,
    cursor: AuxiliarySourceCursor,
    providedHandle?: AuxiliaryFileHandle,
  ): Promise<AuxiliarySourceMetadata> {
    this.validateAuxiliaryCursorShape(stat, cursor);
    const generation = this.appendGenerations.get(file) ?? 0;
    const key = cursorKey(cursor);
    const cached = this.appendStates.get(file);
    let handle = providedHandle;
    let ownsHandle = false;
    if (!handle) {
      handle = await fs.open(file, 'r').catch(() => undefined);
      if (!handle) throw new AuxiliaryAppendError('source-truncated');
      ownsHandle = true;
    }
    try {
      const before = await handle.stat();
      this.validateAuxiliaryCursorShape(before, cursor);
      const beforeMetadata = auxiliarySourceMetadata(before);
      if (
        cached?.cursorKey === key &&
        cached.generation === generation &&
        sameAuxiliarySourceMetadata(cached.source, before)
      ) {
        const after = await handle.stat();
        if (!sameAuxiliarySourceMetadata(cached.source, after))
          throw new AuxiliaryAppendError('source-rewrite');
        if ((this.appendGenerations.get(file) ?? 0) !== generation)
          throw new AuxiliaryAppendError(
            'source-rewrite',
            'Auxiliary source changed while validating its cursor.',
          );
        return cached.source;
      }
      const prefix = await this.hashAuxiliaryPrefix(handle, cursor.byteOffset);
      if (
        prefix.hash.copy().digest('hex') !== cursor.prefixHash ||
        prefix.ordinal !== cursor.ordinal
      )
        throw new AuxiliaryAppendError(
          'source-rewrite',
          'Auxiliary session source prefix changed.',
        );
      const after = await handle.stat();
      if (!sameAuxiliarySourceMetadata(beforeMetadata, after))
        throw new AuxiliaryAppendError('source-rewrite');
      if ((this.appendGenerations.get(file) ?? 0) !== generation)
        throw new AuxiliaryAppendError(
          'source-rewrite',
          'Auxiliary source changed while validating its cursor.',
        );
      this.appendStates.set(file, {
        cursorKey: key,
        generation,
        hash: prefix.hash.copy(),
        source: beforeMetadata,
      });
      return beforeMetadata;
    } finally {
      if (ownsHandle) await handle.close().catch(() => undefined);
    }
  }

  private async verifyAuxiliaryHandleStable(
    file: string,
    handle: AuxiliaryFileHandle,
    expected: AuxiliarySourceMetadata,
  ): Promise<void> {
    const current = await handle.stat();
    if (current.dev !== expected.dev || current.ino !== expected.ino)
      throw new AuxiliaryAppendError(
        'source-replaced',
        'Auxiliary session file identity changed while reading.',
      );
    if (current.size < expected.size)
      throw new AuxiliaryAppendError(
        'source-truncated',
        'Auxiliary session file was truncated while reading.',
      );
    const pathStat = await fs.stat(file).catch(() => undefined);
    const pathWasReplaced =
      pathStat === undefined ||
      pathStat.dev !== expected.dev ||
      pathStat.ino !== expected.ino;
    // An atomic rename changes ctime on the old inode, but the descriptor still
    // points at the validated bytes. Permit that known pathname replacement
    // only when size and mtime remain stable; in-place writes still fail closed.
    if (
      pathWasReplaced &&
      current.size === expected.size &&
      current.mtimeMs === expected.mtimeMs
    )
      return;
    if (!sameAuxiliarySourceMetadata(expected, current))
      throw new AuxiliaryAppendError(
        'source-rewrite',
        'Auxiliary session file changed while reading.',
      );
  }

  private validateAuxiliaryCursorShape(
    stat: import('node:fs').Stats,
    cursor: AuxiliarySourceCursor,
  ): void {
    if (
      cursor.version !== 1 ||
      !Number.isSafeInteger(cursor.dev) ||
      !Number.isSafeInteger(cursor.ino) ||
      !Number.isSafeInteger(cursor.ordinal) ||
      cursor.ordinal < 0 ||
      !Number.isSafeInteger(cursor.byteOffset) ||
      cursor.byteOffset < 0 ||
      !/^[a-f0-9]{64}$/.test(cursor.prefixHash)
    )
      throw new AuxiliaryAppendError(
        'source-rewrite',
        'Invalid source cursor.',
      );
    if (cursor.dev !== stat.dev || cursor.ino !== stat.ino)
      throw new AuxiliaryAppendError(
        'source-replaced',
        'Auxiliary session file identity changed.',
      );
    if (stat.size < cursor.byteOffset)
      throw new AuxiliaryAppendError(
        'source-truncated',
        'Auxiliary session file was truncated.',
      );
  }

  private async hashAuxiliaryPrefix(
    handle: AuxiliaryFileHandle,
    byteOffset: number,
  ): Promise<{ hash: Hash; ordinal: number }> {
    const hash = createHash('sha256');
    if (byteOffset === 0) return { hash, ordinal: 0 };
    let position = 0;
    let ordinal = 0;
    let nonEmpty = false;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (position < byteOffset) {
      const length = Math.min(buffer.length, byteOffset - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0)
        throw new AuxiliaryAppendError(
          'source-truncated',
          'Auxiliary session file ended before its cursor.',
        );
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      for (const byte of chunk) {
        if (byte === 0x0a) {
          if (nonEmpty) ordinal += 1;
          nonEmpty = false;
        } else if (!isJsonlWhitespaceByte(byte)) nonEmpty = true;
      }
      position += bytesRead;
    }
    if (position !== byteOffset)
      throw new AuxiliaryAppendError('source-truncated');
    if (nonEmpty)
      throw new AuxiliaryAppendError(
        'source-rewrite',
        'Cursor is not line aligned.',
      );
    return { hash, ordinal };
  }

  private async scanAuxiliaryAppend(
    id: string,
    cursor: AuxiliarySourceCursor | undefined,
    options: {
      collect: boolean;
      enforceEntrySize?: boolean;
      tolerateMalformed?: boolean;
    },
  ): Promise<AuxiliaryAppendRange> {
    const { file } = await this.auxiliaryFile(id);
    const generation = this.appendGenerations.get(file) ?? 0;
    const cached =
      cursor !== undefined &&
      this.appendStates.get(file)?.cursorKey === cursorKey(cursor) &&
      this.appendStates.get(file)?.generation === generation
        ? this.appendStates.get(file)
        : undefined;
    const handle = await fs.open(file, 'r').catch(() => undefined);
    if (!handle)
      throw new AuxiliaryAppendError(
        'source-truncated',
        'Auxiliary session file disappeared.',
      );
    let before: import('node:fs').Stats;
    let sourceEnd: number;
    let start: AuxiliarySourceCursor;
    let hash: Hash;
    try {
      before = await handle.stat();
      start =
        cursor === undefined
          ? {
              version: 1,
              dev: before.dev,
              ino: before.ino,
              ordinal: 0,
              byteOffset: 0,
              prefixHash: EMPTY_PREFIX_HASH,
            }
          : cursor;
      if (cursor !== undefined) {
        this.validateAuxiliaryCursorShape(before, cursor);
        if (cached && sameAuxiliarySourceMetadata(cached.source, before))
          hash = cached.hash.copy();
        else {
          const prefix = await this.hashAuxiliaryPrefix(
            handle,
            cursor.byteOffset,
          );
          if (
            prefix.hash.copy().digest('hex') !== cursor.prefixHash ||
            prefix.ordinal !== cursor.ordinal
          )
            throw new AuxiliaryAppendError(
              'source-rewrite',
              'Auxiliary session source prefix changed.',
            );
          hash = prefix.hash;
        }
      } else hash = createHash('sha256');
      sourceEnd = before.size;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }

    const records: unknown[] = [];
    let position = start.byteOffset;
    let pending = Buffer.alloc(0);
    let ordinal = start.ordinal;
    let nextOffset = start.byteOffset;
    let completeBytes = 0;
    let stopped = false;
    const maxBytes = options.collect
      ? AUXILIARY_RANGE_BYTES
      : Number.POSITIVE_INFINITY;
    const maxRecords = options.collect
      ? AUXILIARY_RANGE_RECORDS
      : Number.POSITIVE_INFINITY;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let finalStat: import('node:fs').Stats;
    const appendRecord = (rawLine: Buffer, rawWithNewline: Buffer): void => {
      const withoutCr =
        rawLine.length > 0 && rawLine.at(-1) === 0x0d
          ? rawLine.subarray(0, rawLine.length - 1)
          : rawLine;
      let text: string;
      try {
        text = decoder.decode(withoutCr);
      } catch {
        throw new AuxiliaryAppendError(
          'source-malformed',
          'Auxiliary JSONL contains invalid UTF-8.',
        );
      }
      if (isBlankJsonlLine(withoutCr)) {
        hash.update(rawWithNewline);
        nextOffset += rawWithNewline.length;
        return;
      }
      if (
        options.enforceEntrySize !== false &&
        withoutCr.length > AUXILIARY_ENTRY_BYTES
      )
        throw new AuxiliaryAppendError(
          'entry-too-large',
          'Auxiliary JSONL entry exceeds the append budget.',
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        if (options.tolerateMalformed) {
          hash.update(rawWithNewline);
          nextOffset += rawWithNewline.length;
          ordinal += 1;
          completeBytes += rawWithNewline.length;
          return;
        }
        throw new AuxiliaryAppendError(
          'source-malformed',
          'Auxiliary JSONL contains a malformed complete entry.',
        );
      }
      hash.update(rawWithNewline);
      nextOffset += rawWithNewline.length;
      ordinal += 1;
      completeBytes += rawWithNewline.length;
      if (options.collect) records.push(redactImageData(parsed));
    };
    try {
      while (!stopped && position < sourceEnd) {
        const length = Math.min(buffer.length, sourceEnd - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        pending =
          pending.length === 0
            ? Buffer.from(buffer.subarray(0, bytesRead))
            : Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        if (
          pending.length >
            (options.enforceEntrySize === false
              ? AUXILIARY_SEED_PARTIAL_BYTES
              : AUXILIARY_ENTRY_BYTES) +
              1 &&
          !pending.includes(0x0a)
        )
          throw new AuxiliaryAppendError(
            'entry-too-large',
            'Auxiliary JSONL entry exceeds the append budget.',
          );
        while (true) {
          const newline = pending.indexOf(0x0a);
          if (newline < 0) break;
          const rawLine = pending.subarray(0, newline);
          const rawWithNewline = pending.subarray(0, newline + 1);
          appendRecord(rawLine, rawWithNewline);
          pending = pending.subarray(newline + 1);
          if (
            records.length >= maxRecords ||
            (completeBytes >= maxBytes && records.length > 0)
          ) {
            stopped = true;
            break;
          }
        }
      }
      if (
        !stopped &&
        pending.length >
          (options.enforceEntrySize === false
            ? AUXILIARY_SEED_PARTIAL_BYTES
            : AUXILIARY_ENTRY_BYTES)
      )
        throw new AuxiliaryAppendError(
          'entry-too-large',
          'Auxiliary JSONL partial entry exceeds the append budget.',
        );
      finalStat = await handle.stat();
    } finally {
      await handle.close().catch(() => undefined);
    }

    if (finalStat.dev !== before.dev || finalStat.ino !== before.ino)
      throw new AuxiliaryAppendError(
        'source-replaced',
        'Auxiliary session file identity changed while reading.',
      );
    if (
      !sameAuxiliarySourceMetadata(auxiliarySourceMetadata(before), finalStat)
    )
      throw new AuxiliaryAppendError(
        'source-rewrite',
        'Auxiliary session file changed while reading.',
      );
    if (finalStat.size < nextOffset)
      throw new AuxiliaryAppendError(
        'source-truncated',
        'Auxiliary session file was truncated while reading.',
      );
    if ((this.appendGenerations.get(file) ?? 0) !== generation)
      throw new AuxiliaryAppendError(
        'source-rewrite',
        'Auxiliary source changed while reading its append range.',
      );
    const prefixHash = hash.copy().digest('hex');
    const nextCursor: AuxiliarySourceCursor = {
      version: 1,
      dev: before.dev,
      ino: before.ino,
      ordinal,
      byteOffset: nextOffset,
      prefixHash,
    };
    this.appendStates.set(file, {
      cursorKey: cursorKey(nextCursor),
      generation,
      hash: hash.copy(),
      source: auxiliarySourceMetadata(before),
    });
    if ((this.appendGenerations.get(file) ?? 0) !== generation) {
      this.appendStates.delete(file);
      throw new AuxiliaryAppendError(
        'source-rewrite',
        'Auxiliary source changed while accepting its append range.',
      );
    }
    return {
      records,
      nextCursor,
      hasMore: sourceEnd > nextOffset,
    };
  }

  private async *readHandleChunks(
    handle: AuxiliaryFileHandle,
    end: number,
  ): AsyncGenerator<Buffer> {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < end) {
      const length = Math.min(buffer.length, end - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) return;
      yield Buffer.from(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  }

  private sourceReadStream(
    file: string,
    sourceCursor: AuxiliarySourceCursor | undefined,
    sourceHandle?: AuxiliaryFileHandle,
  ): import('node:stream').Readable {
    if (sourceCursor?.byteOffset === 0) return Readable.from([]);
    if (sourceHandle && sourceCursor) {
      const input = Readable.from(
        this.readHandleChunks(sourceHandle, sourceCursor.byteOffset),
      );
      input.setEncoding('utf8');
      return input;
    }
    return createReadStream(file, {
      encoding: 'utf8',
      ...(sourceCursor === undefined
        ? {}
        : { start: 0, end: sourceCursor.byteOffset - 1 }),
    });
  }

  private async currentIndexedFile(id: string): Promise<IndexedFile> {
    let indexed = this.files.get(id);
    if (!indexed || !(await this.isSafeSessionFile(indexed.file)))
      throw new Error('Unknown session.');
    const stat = await fs.stat(indexed.file).catch(() => undefined);
    if (!stat) throw new Error('Unknown session.');
    const previous = indexed.historyIndex;
    if (
      stat.dev !== previous.dev ||
      stat.ino !== previous.ino ||
      stat.size < previous.size
    )
      throw new Error('Stale history cursor.');
    if (
      stat.size !== previous.size ||
      stat.mtimeMs !== previous.mtimeMs ||
      stat.ctimeMs !== previous.ctimeMs
    ) {
      // A watcher may not have delivered an append yet. Refresh exactly once;
      // the refresh itself is the only operation allowed to scan the file.
      await this.indexFile(indexed.file, this.workspaces, [
        ...previous.prefixHashes.keys(),
      ]);
      indexed = this.files.get(id);
      if (!indexed) throw new Error('Unknown session.');
    }
    return indexed;
  }

  private selectHistoryPage(
    descriptors: readonly SessionLineDescriptor[],
    groups: readonly import('@pi-dashboard/activity-model').ActivityGroup[],
    end: number,
  ): {
    start: number;
    entries: readonly SessionLineDescriptor[];
    leadingContinuation: boolean;
  } {
    if (end < 0 || end > descriptors.length)
      throw new Error('Stale history cursor.');
    let cursor = end;
    let pageBytes = 0;
    let pageEntries = 0;
    while (cursor > 0) {
      const descriptor = descriptors[cursor - 1];
      if (!descriptor) break;
      const nextBytes = pageBytes + descriptor.outputBytes;
      if (
        pageEntries > 0 &&
        (nextBytes > HISTORY_PAGE_BYTES || pageEntries >= HISTORY_PAGE_ENTRIES)
      )
        break;
      cursor -= 1;
      pageEntries += 1;
      pageBytes = nextBytes;
    }
    const nominalStart = cursor;
    let start = nominalStart;
    let overscanBytes = 0;
    let overscanEntries = 0;
    let leadingContinuation = false;
    const group = owningActivityGroup(groups, nominalStart);
    if (group && group.start < nominalStart) {
      for (let index = nominalStart - 1; index >= group.start; index -= 1) {
        const descriptor = descriptors[index];
        if (!descriptor) break;
        if (
          overscanEntries >= HISTORY_OVERSCAN_ENTRIES ||
          overscanBytes + descriptor.outputBytes > HISTORY_OVERSCAN_BYTES
        ) {
          leadingContinuation = true;
          break;
        }
        overscanEntries += 1;
        overscanBytes += descriptor.outputBytes;
        start = index;
      }
      if (start > group.start) leadingContinuation = true;
    }
    return {
      start,
      entries: descriptors.slice(start, end),
      leadingContinuation,
    };
  }

  private async readHistoryDescriptors(
    file: string,
    descriptors: readonly SessionLineDescriptor[],
  ): Promise<unknown[]> {
    if (descriptors.length === 0) return [];
    const handle = await fs.open(file, 'r').catch(() => undefined);
    if (!handle) throw new Error('Unknown session.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      const entries: unknown[] = [];
      for (const descriptor of descriptors) {
        const length = descriptor.end - descriptor.start;
        if (length <= 0 || length > 64 * 1024 * 1024)
          throw new Error('Stale history cursor.');
        const bytes = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
          const result = await handle.read(
            bytes,
            offset,
            length - offset,
            descriptor.start + offset,
          );
          if (result.bytesRead === 0) throw new Error('Stale history cursor.');
          offset += result.bytesRead;
          this.historyReadBytesTotal += result.bytesRead;
          this.onHistoryReadBytes?.(result.bytesRead);
        }
        let line: string;
        try {
          line = decoder.decode(
            bytes.subarray(
              0,
              bytes.at(-1) === 0x0a ? bytes.length - 1 : bytes.length,
            ),
          );
        } catch {
          throw new Error('Stale history cursor.');
        }
        if (line.endsWith('\r')) line = line.slice(0, -1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          throw new Error('Stale history cursor.');
        }
        const entry = redactImageData(parsed);
        const serialized = JSON.stringify(entry);
        if (serialized === undefined) throw new Error('Stale history cursor.');
        const originalBytes = Buffer.byteLength(serialized);
        entries.push(
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
            : entry,
        );
      }
      return entries;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async readIndexedPage(
    indexed: IndexedFile,
    id: string,
    before: string | undefined,
    leafId: string | undefined,
    options: SessionReadOptions,
  ): Promise<SessionEntriesResult> {
    const index = indexed.historyIndex;
    const cursor =
      before === undefined ? undefined : decodeHistoryCursorV2(before);
    const requestedLeaf = cursor?.leafId ?? leafId;
    if (
      cursor &&
      (cursor.sessionId !== id ||
        cursor.file !== indexed.file ||
        cursor.dev !== index.dev ||
        cursor.ino !== index.ino ||
        index.size < cursor.indexedSize ||
        (cursor.leafId !== leafId && leafId !== undefined))
    )
      throw new Error('Stale history cursor.');
    if (cursor) {
      const oldPrefix = index.prefixHashes.get(cursor.indexedSize);
      if (
        oldPrefix !== cursor.fileHash ||
        (index.size === cursor.indexedSize &&
          index.fileHash !== cursor.fileHash)
      )
        throw new Error('Stale history cursor.');
      if (cursor.selectedOrdinal <= 0) throw new Error('Stale history cursor.');
    }

    const branch =
      requestedLeaf !== undefined || (options.resolveLatestLeaf && !cursor)
        ? branchPageDescriptors(index, requestedLeaf ?? index.latestEntryId)
        : { descriptors: [...index.descriptors] };
    const descriptors = branch.descriptors;
    const groups =
      branch.leafId === undefined && requestedLeaf === undefined
        ? index.groups
        : groupTranscript(descriptors.map((descriptor) => descriptor.activity));
    let end = descriptors.length;
    if (cursor) {
      const boundary = descriptors[cursor.selectedOrdinal];
      if (
        !boundary ||
        boundary.start !== cursor.selectedByteOffset ||
        boundary.prefixHash !== cursor.prefixHash
      )
        throw new Error('Stale history cursor.');
      end = cursor.selectedOrdinal;
    }
    const selection = this.selectHistoryPage(descriptors, groups, end);
    const readStart = await fs.stat(indexed.file).catch(() => undefined);
    if (
      !readStart ||
      readStart.dev !== index.dev ||
      readStart.ino !== index.ino ||
      readStart.size !== index.size ||
      readStart.mtimeMs !== index.mtimeMs ||
      readStart.ctimeMs !== index.ctimeMs
    )
      throw new SessionFileChangedError();
    const entries = await this.readHistoryDescriptors(
      indexed.file,
      selection.entries,
    );
    const after = await fs.stat(indexed.file).catch(() => undefined);
    // A writer can win while descriptor reads are in flight. Any metadata
    // change invalidates the page, including append growth; the caller then
    // refreshes the index and revalidates its cursor before retrying.
    const settled = await fs.stat(indexed.file).catch(() => undefined);
    const observed = settled ?? after;
    if (
      !observed ||
      !after ||
      observed.dev !== readStart.dev ||
      observed.ino !== readStart.ino ||
      observed.size !== readStart.size ||
      observed.mtimeMs !== readStart.mtimeMs ||
      observed.ctimeMs !== readStart.ctimeMs ||
      after.dev !== readStart.dev ||
      after.ino !== readStart.ino ||
      after.size !== readStart.size ||
      after.mtimeMs !== readStart.mtimeMs ||
      after.ctimeMs !== readStart.ctimeMs
    )
      throw new SessionFileChangedError();
    const metadata = this.publicEntry(indexed);
    const nextBefore =
      selection.start > 0
        ? encodeHistoryCursorV2({
            version: 2,
            sessionId: id,
            file: indexed.file,
            dev: index.dev,
            ino: index.ino,
            indexedSize: index.size,
            selectedOrdinal: selection.start,
            selectedByteOffset: selection.entries[0]?.start ?? 0,
            prefixHash:
              selection.entries[0]?.prefixHash ??
              index.prefixHashes.get(0) ??
              EMPTY_PREFIX_HASH,
            fileHash: index.fileHash,
            ...(branch.leafId === undefined && requestedLeaf === undefined
              ? {}
              : { leafId: branch.leafId ?? requestedLeaf }),
          })
        : undefined;
    return {
      metadata,
      entries,
      entriesComplete: before === undefined && selection.start === 0,
      history: {
        version: 1,
        start: selection.start,
        end,
        hasOlder: selection.start > 0,
        ...(nextBefore === undefined ? {} : { nextBefore }),
        ...(selection.leadingContinuation ? { leadingContinuation: true } : {}),
      },
    };
  }

  private async readIndexedEntries(
    id: string,
    before: string | undefined,
    leafId: string | undefined,
    options: SessionReadOptions,
  ): Promise<SessionEntriesResult> {
    for (let attempt = 0; attempt < LATEST_LEAF_READ_ATTEMPTS; attempt += 1) {
      try {
        const indexed = await this.currentIndexedFile(id);
        return await this.readIndexedPage(indexed, id, before, leafId, options);
      } catch (error) {
        if (
          !(error instanceof SessionFileChangedError) ||
          attempt === LATEST_LEAF_READ_ATTEMPTS - 1
        )
          throw error;
        // The next iteration refreshes the in-memory index and resolves the
        // latest leaf once, without a byte-zero ancestry pass.
      }
    }
    throw new Error('Unable to resolve the latest session branch.');
  }

  /**
   * Read an indexed page. Auxiliary exact-cut reads retain their dedicated
   * append cursor implementation; browser history never enters the legacy
   * streaming path below.
   */
  async readEntries(
    id: string,
    before?: string,
    leafId?: string,
    options: SessionReadOptions = {},
  ): Promise<SessionEntriesResult> {
    if (options.sourceCursor !== undefined)
      return this.readEntriesLegacy(id, before, leafId, options);
    return this.readIndexedEntries(id, before, leafId, options);
  }

  private async readEntriesLegacy(
    id: string,
    before?: string,
    leafId?: string,
    options: SessionReadOptions = {},
  ): Promise<SessionEntriesResult> {
    const indexed = this.files.get(id);
    if (!indexed || !(await this.isSafeSessionFile(indexed.file)))
      throw new Error('Unknown session.');
    const sourceCursor = options.sourceCursor;
    let sourceHandle: AuxiliaryFileHandle | undefined;
    let sourceMetadata: AuxiliarySourceMetadata | undefined;
    let stat: import('node:fs').Stats;
    try {
      if (sourceCursor !== undefined) {
        sourceHandle = await fs.open(indexed.file, 'r').catch(() => undefined);
        if (!sourceHandle) throw new Error('Unknown session.');
        stat = await sourceHandle.stat();
        sourceMetadata = await this.validateAuxiliaryCursor(
          indexed.file,
          stat,
          sourceCursor,
          sourceHandle,
        );
      } else {
        const diskStat = await fs.stat(indexed.file).catch(() => undefined);
        if (!diskStat) throw new Error('Unknown session.');
        stat = diskStat;
      }
      const readStat =
        sourceCursor === undefined
          ? stat
          : Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
              size: sourceCursor.byteOffset,
            });
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
              readStat,
              metadata,
              requestedLeafId,
              cursor,
              false,
              undefined,
              undefined,
              sourceCursor,
              sourceHandle,
              sourceMetadata,
            ),
          );
        let latestStat = stat;
        for (
          let attempt = 0;
          attempt < LATEST_LEAF_READ_ATTEMPTS;
          attempt += 1
        ) {
          try {
            return publicBranchResult(
              await this.readBranchEntries(
                id,
                indexed.file,
                sourceCursor === undefined ? latestStat : readStat,
                metadata,
                undefined,
                cursor,
                true,
                undefined,
                undefined,
                sourceCursor,
                sourceHandle,
                sourceMetadata,
              ),
            );
          } catch (error) {
            if (
              !(error instanceof SessionFileChangedError) ||
              attempt === LATEST_LEAF_READ_ATTEMPTS - 1
            )
              throw error;
            const refreshed = await fs
              .stat(indexed.file)
              .catch(() => undefined);
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
      const input = this.sourceReadStream(
        indexed.file,
        sourceCursor,
        sourceHandle,
      );
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
            size: readStat.size,
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
        ...(sourceCursor === undefined ? {} : { sourceCursor }),
      };
    } finally {
      if (sourceHandle) {
        try {
          if (sourceMetadata)
            await this.verifyAuxiliaryHandleStable(
              indexed.file,
              sourceHandle,
              sourceMetadata,
            );
        } finally {
          await sourceHandle.close().catch(() => undefined);
        }
      }
    }
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
    const sourceCursor = options.sourceCursor;
    let sourceHandle: AuxiliaryFileHandle | undefined;
    let sourceMetadata: AuxiliarySourceMetadata | undefined;
    let stat: import('node:fs').Stats;
    try {
      if (sourceCursor !== undefined) {
        sourceHandle = await fs.open(indexed.file, 'r').catch(() => undefined);
        if (!sourceHandle) throw new Error('Unknown session.');
        stat = await sourceHandle.stat();
        sourceMetadata = await this.validateAuxiliaryCursor(
          indexed.file,
          stat,
          sourceCursor,
          sourceHandle,
        );
      } else {
        const diskStat = await fs.stat(indexed.file).catch(() => undefined);
        if (!diskStat) throw new Error('Unknown session.');
        stat = diskStat;
      }
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
            sourceCursor,
            sourceHandle,
            sourceMetadata,
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
    } finally {
      if (sourceHandle) {
        try {
          if (sourceMetadata)
            await this.verifyAuxiliaryHandleStable(
              indexed.file,
              sourceHandle,
              sourceMetadata,
            );
        } finally {
          await sourceHandle.close().catch(() => undefined);
        }
      }
    }
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
    sourceCursor?: AuxiliarySourceCursor,
    sourceHandle?: AuxiliaryFileHandle,
    sourceMetadata?: AuxiliarySourceMetadata,
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
    const verifyPassStability = async (): Promise<void> => {
      if (sourceHandle && sourceMetadata) {
        await this.verifyAuxiliaryHandleStable(
          file,
          sourceHandle,
          sourceMetadata,
        );
        return;
      }
      if (resolveLatestLeaf)
        await verifySessionFileVersion(file, stat, sourceCursor !== undefined);
    };
    const firstPassInput = this.sourceReadStream(
      file,
      sourceCursor,
      sourceHandle,
    );
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
    await verifyPassStability();
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
    const secondPassInput = this.sourceReadStream(
      file,
      sourceCursor,
      sourceHandle,
    );
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
    await verifyPassStability();
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
      ...(sourceCursor === undefined ? {} : { sourceCursor }),
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
    this.appendStates.clear();
    this.appendGenerations.clear();
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
      historyIndex: _historyIndex,
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

  private markAuxiliarySourceDirty(file: string): void {
    const resolved = path.resolve(file);
    if (!this.isAuxiliaryFile(resolved)) return;
    this.appendGenerations.set(
      resolved,
      (this.appendGenerations.get(resolved) ?? 0) + 1,
    );
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
      this.markAuxiliarySourceDirty(file);
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
    proofOffsets: readonly number[] = [],
  ): Promise<void> {
    const resolved = path.resolve(file);
    const existingId = this.fileIds.get(resolved);
    const existing =
      existingId === undefined ? undefined : this.files.get(existingId);
    return this.indexFileStreaming(
      file,
      workspaces,
      proofOffsets.concat(
        existing === undefined
          ? []
          : [...existing.historyIndex.prefixHashes.keys()],
      ),
    );
  }

  private async indexFileStreaming(
    file: string,
    workspaces: readonly WorkspaceTarget[],
    proofOffsets: readonly number[],
  ): Promise<void> {
    const resolved = path.resolve(file);
    if (
      !resolved.endsWith('.jsonl') ||
      !(await this.isSafeSessionFile(resolved))
    )
      return this.removeFile(resolved);
    try {
      const handle = await fs.open(resolved, 'r');
      const stat = await handle.stat();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const descriptors: SessionLineDescriptor[] = [];
      const prefixHashes = new Map<number, string>();
      const byId = new Map<string, SessionLineDescriptor>();
      const fullHash = createHash('sha256');
      const checkpoints = [...new Set([0, ...proofOffsets])]
        .filter((offset) => Number.isSafeInteger(offset) && offset >= 0)
        .sort((left, right) => left - right);
      let checkpointIndex = 0;
      prefixHashes.set(0, fullHash.copy().digest('hex'));
      let header: Record<string, unknown> | undefined;
      let name: string | undefined;
      let sawSessionInfo = false;
      let firstUserEntry: unknown;
      let lastEntryId: string | undefined;
      let latestEntryId: string | undefined;
      let ordinal = 0;
      let offset = 0;
      const processLine = (rawLine: Buffer): void => {
        const start = offset;
        const end = start + rawLine.length;
        const newline = rawLine.at(-1) === 0x0a;
        const content = rawLine.subarray(
          0,
          newline ? rawLine.length - 1 : rawLine.length,
        );
        const withoutCr =
          content.at(-1) === 0x0d
            ? content.subarray(0, content.length - 1)
            : content;
        const prefixHash = fullHash.copy().digest('hex');
        if (!isBlankJsonlLine(withoutCr)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(decoder.decode(withoutCr)) as unknown;
          } catch {
            // Malformed and partial lines remain physical bytes but are not
            // logical descriptors.
            updateRawPrefix(rawLine, start, prefixHash);
            offset = end;
            return;
          }
          const resume = resumeFromRawEntry(parsed);
          if (!header) {
            if (!isRecord(parsed) || parsed.type !== 'session') {
              throw new Error('Invalid session header.');
            }
            header = parsed;
            const entry = redactImageData(parsed);
            const descriptor: SessionLineDescriptor = {
              ordinal,
              start,
              end,
              outputBytes: Math.min(
                Buffer.byteLength(JSON.stringify(entry) ?? ''),
                HISTORY_PAGE_BYTES,
              ),
              prefixHash,
              ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}),
              ...(Object.hasOwn(parsed, 'parentId')
                ? { parentId: parsed.parentId }
                : {}),
              type: 'session',
              activity: activityEntryFromRaw(parsed),
            };
            descriptors.push(descriptor);
            if (descriptor.id !== undefined) {
              byId.set(descriptor.id, descriptor);
              lastEntryId = descriptor.id;
              latestEntryId = descriptor.id;
            }
            ordinal += 1;
          } else {
            const entry = redactImageData(parsed);
            const descriptor: SessionLineDescriptor = {
              ordinal,
              start,
              end,
              outputBytes: Math.min(
                Buffer.byteLength(JSON.stringify(entry) ?? ''),
                HISTORY_PAGE_BYTES,
              ),
              prefixHash,
              ...(isRecord(parsed) && typeof parsed.id === 'string'
                ? { id: parsed.id }
                : {}),
              ...(isRecord(parsed) && Object.hasOwn(parsed, 'parentId')
                ? { parentId: parsed.parentId }
                : {}),
              ...(isRecord(parsed) && typeof parsed.type === 'string'
                ? { type: parsed.type }
                : {}),
              ...(resume ? { resume } : {}),
              activity: activityEntryFromRaw(parsed),
            };
            descriptors.push(descriptor);
            if (descriptor.id !== undefined) {
              byId.set(descriptor.id, descriptor);
              lastEntryId = descriptor.id;
              latestEntryId = descriptor.id;
            }
            if (
              firstUserEntry === undefined &&
              isRecord(parsed) &&
              parsed.type === 'message' &&
              isRecord(parsed.message) &&
              parsed.message.role === 'user'
            )
              firstUserEntry = parsed;
            if (isRecord(parsed) && parsed.type === 'session_info') {
              sawSessionInfo = true;
              name =
                typeof parsed.name === 'string'
                  ? parsed.name.trim() || undefined
                  : undefined;
            }
            ordinal += 1;
          }
        }
        updateRawPrefix(rawLine, start, prefixHash);
        offset = end;
      };
      const updateRawPrefix = (
        rawLine: Buffer,
        start: number,
        _prefixHash: string,
      ): void => {
        let consumed = 0;
        while (checkpointIndex < checkpoints.length) {
          const checkpoint = checkpoints[checkpointIndex];
          if (checkpoint === undefined || checkpoint >= start + rawLine.length)
            break;
          if (checkpoint < start) {
            checkpointIndex += 1;
            continue;
          }
          const length = checkpoint - start - consumed;
          if (length > 0)
            fullHash.update(rawLine.subarray(consumed, consumed + length));
          consumed += Math.max(0, length);
          prefixHashes.set(checkpoint, fullHash.copy().digest('hex'));
          checkpointIndex += 1;
        }
        if (consumed < rawLine.length)
          fullHash.update(rawLine.subarray(consumed));
        prefixHashes.set(start + rawLine.length, fullHash.copy().digest('hex'));
      };
      // `processLine` calls the function declared below; initialize the
      // closure before reading any source bytes.
      const chunk = Buffer.allocUnsafe(INDEX_SCAN_CHUNK_BYTES);
      let pending = Buffer.alloc(0);
      let pendingStart = 0;
      try {
        while (true) {
          const result = await handle.read(chunk, 0, chunk.length, null);
          if (result.bytesRead === 0) break;
          pending =
            pending.length === 0
              ? Buffer.from(chunk.subarray(0, result.bytesRead))
              : Buffer.concat([pending, chunk.subarray(0, result.bytesRead)]);
          this.onIndexPendingBytes?.(pending.length);
          while (true) {
            const newline = pending.indexOf(0x0a);
            if (newline < 0) break;
            const rawLine = Buffer.from(pending.subarray(0, newline + 1));
            offset = pendingStart;
            processLine(rawLine);
            pending = pending.subarray(newline + 1);
            pendingStart += rawLine.length;
          }
          if (pending.length > INDEX_MAX_LINE_BYTES)
            throw new Error('Session index line exceeds bounded scan limit.');
        }
        if (pending.length > 0) {
          offset = pendingStart;
          processLine(Buffer.from(pending));
        }
        const endStat = await handle.stat();
        if (
          endStat.dev !== stat.dev ||
          endStat.ino !== stat.ino ||
          endStat.size !== offset
        )
          throw new SessionFileChangedError();
        if (!header || typeof header.cwd !== 'string') {
          this.removeFile(resolved);
          return;
        }
        const historyIndex: SessionHistoryIndex = {
          dev: endStat.dev,
          ino: endStat.ino,
          size: endStat.size,
          mtimeMs: endStat.mtimeMs,
          ctimeMs: endStat.ctimeMs,
          fileHash: fullHash.copy().digest('hex'),
          prefixHashes,
          descriptors,
          byId,
          latestEntryId,
          groups: groupTranscript(
            descriptors.map((descriptor) => descriptor.activity),
          ),
        };
        const id =
          typeof header.id === 'string' ? header.id : this.idForPath(resolved);
        const previous = this.files.get(id);
        if (previous && previous.file !== resolved) {
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
              : endStat.birthtimeMs,
          updatedAt: endStat.mtimeMs,
          ...resumeMetadataFromDescriptors(historyIndex, latestEntryId),
          header,
          lastEntryId,
          historyIndex,
        };
        this.files.set(id, entry);
        this.fileIds.set(resolved, id);
        if (!this.isAuxiliaryFile(resolved)) this.metadata?.saveSession(entry);
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (!(error instanceof SessionFileChangedError))
        this.removeFile(resolved);
      throw error;
    }
  }

  private removeFile(file: string): void {
    const resolved = path.resolve(file);
    const id = this.fileIds.get(resolved);
    this.fileIds.delete(resolved);
    this.appendStates.delete(resolved);
    this.appendGenerations.delete(resolved);
    if (id && this.files.get(id)?.file === resolved) this.files.delete(id);
  }
}
