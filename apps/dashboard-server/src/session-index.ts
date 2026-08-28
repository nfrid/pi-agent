import { createHash, type Hash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
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
  type SessionOutlineLandmark,
  validateSessionName,
} from '@pi-dashboard/protocol';
import type { MetadataStore } from './metadata.js';
import {
  decodeHistoryCursor,
  decodeHistoryCursorV2,
  encodeHistoryCursor,
  encodeHistoryCursorV2,
  type HistoryCursor,
  isLegacyHistoryCursor,
} from './session-index/history-cursor.js';

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
  readonly outlineId?: string;
  readonly outlineKind?: SessionOutlineLandmark['kind'];
  readonly outlineLabel?: string;
  readonly timestamp?: number | string;
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
  readonly outline: readonly SessionOutlineLandmark[];
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

export interface SessionImage {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface SessionEntriesResult {
  metadata: SessionIndexEntry;
  entries: unknown[];
  entriesComplete: boolean;
  history: SessionHistoryPage;
  /** Complete lightweight transcript outline; payloads remain paginated. */
  outline?: readonly SessionOutlineLandmark[];
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
const MAX_SESSION_OUTLINE = 4096;

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

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function compactOutlineText(value: unknown, limit = 220): string | undefined {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/gu, ' ').trim();
    return text ? text.slice(0, limit) : undefined;
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      const text = compactOutlineText(part, limit);
      if (text) return text;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  return compactOutlineText(value.text ?? value.content, limit);
}

function outlineFields(
  value: unknown,
  activity: TranscriptEntry,
): Pick<
  SessionLineDescriptor,
  'outlineId' | 'outlineKind' | 'outlineLabel' | 'timestamp'
> {
  if (!isRecord(value)) return {};
  const message = isRecord(value.message) ? value.message : value;
  const timestamp = message.timestamp ?? value.timestamp;
  const timestampField =
    typeof timestamp === 'number' || typeof timestamp === 'string'
      ? { timestamp }
      : {};
  const candidateId =
    typeof message.messageId === 'string'
      ? message.messageId
      : typeof message.id === 'string'
        ? message.id
        : typeof value.id === 'string'
          ? value.id
          : undefined;
  const outlineId =
    candidateId !== undefined &&
    candidateId.length > 0 &&
    candidateId.length <= 256 &&
    ![...candidateId].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
      ? candidateId
      : undefined;
  const identityField = outlineId === undefined ? {} : { outlineId };
  if (message.role === 'user') {
    return {
      ...identityField,
      outlineKind: 'user',
      outlineLabel:
        compactOutlineText(message.content) ??
        compactOutlineText(value.content) ??
        'User turn',
      ...timestampField,
    };
  }
  if (activity.kind === 'assistant' && activity.titleKind === 'preamble')
    return {
      ...identityField,
      outlineKind: 'activity',
      outlineLabel: compactOutlineText(activity.title) ?? 'Agent activity',
      ...timestampField,
    };
  return timestampField;
}

function buildSessionOutline(
  descriptors: readonly SessionLineDescriptor[],
  groups: readonly ActivityGroup[],
): SessionOutlineLandmark[] {
  const landmarks: SessionOutlineLandmark[] = [];
  const grouped = new Set<number>();
  for (const group of groups) {
    const descriptor = descriptors[group.start];
    if (!descriptor?.outlineLabel) continue;
    grouped.add(group.start);
    landmarks.push({
      id:
        descriptor.outlineId ?? descriptor.id ?? `entry-${descriptor.ordinal}`,
      ordinal: group.start,
      kind: 'activity',
      label: descriptor.outlineLabel,
      ...(descriptor.timestamp === undefined
        ? {}
        : { timestamp: descriptor.timestamp }),
    });
  }
  descriptors.forEach((descriptor, index) => {
    if (!descriptor.outlineLabel || grouped.has(index)) return;
    if (
      descriptor.outlineKind !== 'user' &&
      descriptor.outlineKind !== 'assistant'
    )
      return;
    landmarks.push({
      id:
        descriptor.outlineId ?? descriptor.id ?? `entry-${descriptor.ordinal}`,
      ordinal: index,
      kind: descriptor.outlineKind,
      label: descriptor.outlineLabel,
      ...(descriptor.timestamp === undefined
        ? {}
        : { timestamp: descriptor.timestamp }),
    });
  });
  return landmarks
    .sort((left, right) => left.ordinal - right.ordinal)
    .slice(0, MAX_SESSION_OUTLINE);
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

  async rebuild(): Promise<void> {
    this.files.clear();
    this.fileIds.clear();
    const paths = (
      await Promise.all(this.sessionRoots().map((root) => this.findJsonl(root)))
    ).flat();
    for (const file of paths) await this.indexFile(file).catch(() => undefined);
  }

  async start(): Promise<void> {
    await this.rebuild();
    await Promise.all(
      this.sessionRoots().map((root) => this.ensureWatcher(root)),
    );
  }

  async refresh(): Promise<void> {
    await this.rebuild();
  }

  list(): SessionIndexEntry[] {
    return [...this.files.values()]
      .filter(
        (file) =>
          !this.isAuxiliaryFile(file.file) ||
          (file.sessionKind === 'delegate' &&
            file.parentSessionId !== undefined),
      )
      .map((file) => this.publicEntry(file))
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
      await this.indexFile(indexed.file, [...previous.prefixHashes.keys()]);
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
    const outline =
      branch.leafId === undefined && requestedLeaf === undefined
        ? index.outline
        : buildSessionOutline(descriptors, groups);
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
      outline,
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

  /** Read a bounded persisted JSONL page through the indexed cursor path. */
  async readEntries(
    id: string,
    before?: string,
    leafId?: string,
    options: SessionReadOptions = {},
  ): Promise<SessionEntriesResult> {
    if (before !== undefined && isLegacyHistoryCursor(before))
      return this.readEntriesLegacy(id, before, leafId, options);
    return this.readIndexedEntries(id, before, leafId, options);
  }

  /** Read one image from a proven session entry without exposing file paths. */
  async readImage(
    id: string,
    entryId: string,
    imageIndex: number,
    messageTimestamp?: number | string,
  ): Promise<SessionImage> {
    if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex > 3)
      throw new Error('Invalid session image.');
    const indexed = await this.currentIndexedFile(id);
    let descriptor = indexed.historyIndex.byId.get(entryId);
    if (!descriptor && messageTimestamp !== undefined) {
      const matches = indexed.historyIndex.descriptors.filter(
        (candidate) =>
          candidate.type === 'message' &&
          candidate.timestamp === messageTimestamp,
      );
      if (matches.length === 1) descriptor = matches[0];
    }
    if (!descriptor) throw new Error('Unknown session image.');
    const handle = await fs.open(indexed.file, 'r');
    try {
      const size = descriptor.end - descriptor.start;
      if (size <= 0 || size > INDEX_MAX_LINE_BYTES)
        throw new Error('Invalid session image.');
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        size,
        descriptor.start,
      );
      if (bytesRead !== size) throw new Error('Session file changed.');
      const entry = JSON.parse(buffer.toString('utf8').trim()) as unknown;
      if (!isRecord(entry)) throw new Error('Invalid session image.');
      const message = isRecord(entry.message) ? entry.message : entry;
      if (!Array.isArray(message.content))
        throw new Error('Unknown session image.');
      const images = message.content.filter(
        (part): part is Record<string, unknown> =>
          isRecord(part) && part.type === 'image',
      );
      const image = images[imageIndex];
      if (!image) throw new Error('Unknown session image.');
      const source = isRecord(image.source) ? image.source : undefined;
      const data =
        typeof image.data === 'string'
          ? image.data
          : source?.type === 'base64' && typeof source.data === 'string'
            ? source.data
            : undefined;
      const mediaType =
        typeof image.mimeType === 'string'
          ? image.mimeType
          : typeof source?.media_type === 'string'
            ? source.media_type
            : typeof source?.mediaType === 'string'
              ? source.mediaType
              : undefined;
      if (
        !data ||
        (mediaType !== 'image/png' &&
          mediaType !== 'image/jpeg' &&
          mediaType !== 'image/webp')
      )
        throw new Error('Unknown session image.');
      const decoded = Buffer.from(data, 'base64');
      if (decoded.length === 0 || decoded.length > 5 * 1024 * 1024)
        throw new Error('Invalid session image.');
      return { data: decoded, mediaType };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

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

  private async readEntriesLegacy(
    id: string,
    before?: string,
    leafId?: string,
    options: SessionReadOptions = {},
  ): Promise<SessionEntriesResult> {
    const indexed = this.files.get(id);
    if (!indexed || !(await this.isSafeSessionFile(indexed.file)))
      throw new Error('Unknown session.');
    const stat = await fs.stat(indexed.file).catch(() => undefined);
    if (!stat) throw new Error('Unknown session.');
    const readStat = stat;
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
        return { ...response, outline: indexed.historyIndex.outline };
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
              undefined,
              undefined,
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
      outline: indexed.historyIndex.outline,
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
    const verifyPassStability = async (): Promise<void> => {
      if (resolveLatestLeaf) await verifySessionFileVersion(file, stat);
    };
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
    await this.indexFile(indexed.file);
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

  private handleWatcherEvent(
    root: string,
    filename: string | Buffer | null | undefined,
  ): void {
    if (!filename) {
      void this.rebuild()
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
    void this.rebuild()
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
        .then(() => this.indexFile(file))
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
    proofOffsets: readonly number[] = [],
  ): Promise<void> {
    const resolved = path.resolve(file);
    const existingId = this.fileIds.get(resolved);
    const existing =
      existingId === undefined ? undefined : this.files.get(existingId);
    return this.indexFileStreaming(
      file,
      proofOffsets.concat(
        existing === undefined
          ? []
          : [...existing.historyIndex.prefixHashes.keys()],
      ),
    );
  }

  private async indexFileStreaming(
    file: string,
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
            const activity = activityEntryFromRaw(parsed);
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
              activity,
              ...outlineFields(parsed, activity),
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
            const activity = activityEntryFromRaw(parsed);
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
              activity,
              ...outlineFields(parsed, activity),
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
        const groups = groupTranscript(
          descriptors.map((descriptor) => descriptor.activity),
        );
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
          groups,
          outline: buildSessionOutline(descriptors, groups),
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
        const auxiliaryDelegate =
          this.isAuxiliaryFile(resolved) && header.sessionKind === 'delegate';
        const headerParentSessionId =
          auxiliaryDelegate &&
          typeof header.parentSessionId === 'string' &&
          header.parentSessionId.trim().length > 0 &&
          header.parentSessionId.length <= 256 &&
          ![...header.parentSessionId].some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          })
            ? header.parentSessionId.trim()
            : undefined;
        const headerDelegateName =
          auxiliaryDelegate &&
          typeof header.name === 'string' &&
          header.name.trim().length > 0 &&
          header.name.length <= 512 &&
          ![...header.name].some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          })
            ? header.name.trim()
            : undefined;
        const entry: IndexedFile = {
          id,
          file: resolved,
          cwd: header.cwd,
          ...(auxiliaryDelegate ? { sessionKind: 'delegate' as const } : {}),
          ...(headerParentSessionId
            ? { parentSessionId: headerParentSessionId }
            : {}),
          ...(headerDelegateName ? { name: headerDelegateName } : {}),
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
    if (id && this.files.get(id)?.file === resolved) this.files.delete(id);
  }
}
