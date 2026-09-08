import { createHash, type Hash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  type ActivityGroup,
  groupTranscript,
  owningActivityGroup,
} from '@pi-dashboard/activity-model';
import {
  deriveSessionTitle,
  isRecord,
  MAX_SESSION_BRANCH_PATHS,
  MAX_SESSION_BRANCH_PATHS_TOTAL,
  MAX_SESSION_BRANCH_POINTS,
  redactImageData,
  type SessionBranchPath,
  type SessionBranchPoint,
  type SessionBranchTopology,
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
import {
  compactOutlineText,
  HISTORY_PAGE_BYTES,
  INDEX_MAX_LINE_BYTES,
  outlineIdentityId,
  SessionFileChangedError,
  type SessionFileVersion,
  type SessionLineDescriptor,
  scanSessionFile,
  timestampNumber,
} from './session-index/scanner.js';

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

type BranchTopologyCache = {
  activeLeafId: string | undefined;
  topology: SessionBranchTopology;
};

const branchTopologyCache = new WeakMap<
  SessionHistoryIndex,
  BranchTopologyCache
>();

function cloneBranchTopology(
  topology: SessionBranchTopology,
): SessionBranchTopology {
  return {
    ...(topology.activeLeafId === undefined
      ? {}
      : { activeLeafId: topology.activeLeafId }),
    points: topology.points.map((point) => ({
      id: point.id,
      paths: point.paths.map((path) => ({ ...path })),
    })),
  };
}

function branchTopologyForIndex(
  index: SessionHistoryIndex,
  activeLeafId: string | undefined,
): SessionBranchTopology {
  const cached = branchTopologyCache.get(index);
  if (cached && cached.activeLeafId === activeLeafId)
    return cloneBranchTopology(cached.topology);
  const topology = branchTopologyFromDescriptors(
    index.descriptors,
    activeLeafId,
  );
  branchTopologyCache.set(index, { activeLeafId, topology });
  return cloneBranchTopology(topology);
}

interface IndexedFile extends SessionIndexEntry {
  header: Record<string, unknown>;
  lastEntryId?: string;
  historyIndex: SessionHistoryIndex;
}

interface SessionCatalogue {
  readonly kind: 'live' | 'staged';
  readonly epoch: number;
  readonly files: Map<string, IndexedFile>;
  readonly fileIds: Map<string, string>;
  readonly fileRevisions: Map<string, number>;
  readonly pendingMetadata: Map<string, IndexedFile>;
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
  /** Bounded immediate user paths; transcript payloads are not duplicated. */
  branchTopology?: SessionBranchTopology;
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
export { HISTORY_PAGE_BYTES } from './session-index/scanner.js';
export const HISTORY_PAGE_ENTRIES = 256;
/** Extra backward extension reserved for the owning activity group. */
export const HISTORY_OVERSCAN_BYTES = 128 * 1024;
export const HISTORY_OVERSCAN_ENTRIES = 64;
export {
  INDEX_MAX_LINE_BYTES,
  INDEX_SCAN_CHUNK_BYTES,
} from './session-index/scanner.js';

const LATEST_LEAF_READ_ATTEMPTS = 3;
const EMPTY_PREFIX_HASH = createHash('sha256').digest('hex');

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

type BranchDescriptor = Pick<
  SessionLineDescriptor,
  | 'ordinal'
  | 'id'
  | 'parentId'
  | 'outlineId'
  | 'outlineKind'
  | 'outlineLabel'
  | 'timestamp'
>;
type IdentifiedBranchDescriptor = BranchDescriptor & { id: string };

function branchTopologyFromDescriptors(
  descriptors: readonly BranchDescriptor[],
  activeLeafId?: string,
): SessionBranchTopology {
  const byId = new Map<string, IdentifiedBranchDescriptor>();
  const children = new Map<string, IdentifiedBranchDescriptor[]>();
  for (const descriptor of descriptors) {
    if (!descriptor.id || byId.has(descriptor.id)) continue;
    byId.set(descriptor.id, descriptor as IdentifiedBranchDescriptor);
  }
  for (const descriptor of byId.values()) {
    if (
      typeof descriptor.parentId !== 'string' ||
      !byId.has(descriptor.parentId)
    )
      continue;
    const siblings = children.get(descriptor.parentId) ?? [];
    siblings.push(descriptor);
    children.set(descriptor.parentId, siblings);
  }

  // Each user is assigned to its nearest user ancestor once. This collapses
  // model/tool/summary entries without walking every anchor's subtree.
  const nearestUserAncestor = new Map<string, string | undefined>();
  const findNearestUserAncestor = (
    startId: string | undefined,
  ): string | undefined => {
    if (startId === undefined) return undefined;
    if (nearestUserAncestor.has(startId))
      return nearestUserAncestor.get(startId);
    const trail: string[] = [];
    const seen = new Set<string>();
    let currentId: string | undefined = startId;
    let ancestor: string | undefined;
    while (currentId && !seen.has(currentId)) {
      const cached = nearestUserAncestor.get(currentId);
      if (nearestUserAncestor.has(currentId)) {
        ancestor = cached;
        break;
      }
      seen.add(currentId);
      trail.push(currentId);
      const current = byId.get(currentId);
      if (!current) break;
      if (current.outlineKind === 'user') {
        ancestor = current.id;
        break;
      }
      currentId =
        typeof current.parentId === 'string' ? current.parentId : undefined;
    }
    for (const id of trail) nearestUserAncestor.set(id, ancestor);
    return ancestor;
  };
  const usersByAnchor = new Map<string, IdentifiedBranchDescriptor[]>();
  for (const candidate of byId.values()) {
    if (candidate.outlineKind !== 'user') continue;
    const anchorId = findNearestUserAncestor(
      typeof candidate.parentId === 'string' ? candidate.parentId : undefined,
    );
    const anchor = anchorId ? byId.get(anchorId) : undefined;
    if (!anchor || anchor.ordinal >= candidate.ordinal) continue;
    const members = usersByAnchor.get(anchor.id) ?? [];
    members.push(candidate);
    usersByAnchor.set(anchor.id, members);
  }

  // Compute each node's latest activity once, so path metadata remains
  // useful without a user-by-entry subtree walk.
  const latestActivityById = new Map<
    string,
    { value: number | string; sort: number }
  >();
  const visitState = new Map<string, 1 | 2>();
  for (const root of byId.values()) {
    if (visitState.has(root.id)) continue;
    const stack: Array<{
      node: IdentifiedBranchDescriptor;
      expanded: boolean;
    }> = [{ node: root, expanded: false }];
    const visiting = new Set<string>();
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) continue;
      const { node } = frame;
      if (frame.expanded) {
        let latest = timestampNumber(node.timestamp);
        let latestValue =
          latest === undefined
            ? undefined
            : (node.timestamp as number | string);
        for (const child of children.get(node.id) ?? []) {
          const childLatest = latestActivityById.get(child.id);
          if (
            childLatest &&
            (latest === undefined || childLatest.sort >= latest)
          ) {
            latest = childLatest.sort;
            latestValue = childLatest.value;
          }
        }
        if (latest !== undefined && latestValue !== undefined)
          latestActivityById.set(node.id, { value: latestValue, sort: latest });
        visitState.set(node.id, 2);
        visiting.delete(node.id);
        continue;
      }
      if (visitState.has(node.id) || visiting.has(node.id)) continue;
      visiting.add(node.id);
      visitState.set(node.id, 1);
      stack.push({ node, expanded: true });
      for (const child of children.get(node.id) ?? []) {
        if (!visitState.has(child.id))
          stack.push({ node: child, expanded: false });
      }
    }
  }

  const active = new Set<string>();
  if (activeLeafId !== undefined) {
    const seen = new Set<string>();
    let current = byId.get(activeLeafId);
    while (current && !seen.has(current.id)) {
      active.add(current.id);
      seen.add(current.id);
      current =
        typeof current.parentId === 'string'
          ? byId.get(current.parentId)
          : undefined;
    }
  }

  const points: SessionBranchPoint[] = [];
  let totalPaths = 0;
  for (const [anchorId, members] of usersByAnchor) {
    if (members.length < 2 || totalPaths >= MAX_SESSION_BRANCH_PATHS_TOTAL)
      continue;
    const remaining = MAX_SESSION_BRANCH_PATHS_TOTAL - totalPaths;
    const selected = members.slice(
      0,
      Math.min(MAX_SESSION_BRANCH_PATHS, remaining),
    );
    if (selected.length < 2) continue;
    const paths: SessionBranchPath[] = selected.map((candidate) => {
      const latest = latestActivityById.get(candidate.id);
      return {
        id: candidate.id,
        messageId: candidate.outlineId ?? candidate.id,
        label: candidate.outlineLabel ?? 'User turn',
        ...(latest === undefined ? {} : { lastActivityAt: latest.value }),
        current: activeLeafId !== undefined && active.has(candidate.id),
      };
    });
    totalPaths += paths.length;
    points.push({ id: anchorId, paths });
    if (points.length >= MAX_SESSION_BRANCH_POINTS) break;
  }
  return {
    ...(activeLeafId === undefined ? {} : { activeLeafId }),
    points,
  };
}

/** Derive only bounded branch metadata from a persisted or runtime entry list. */
export function deriveSessionBranchTopology(
  entries: readonly unknown[],
  activeLeafId?: string,
): SessionBranchTopology {
  const descriptors: BranchDescriptor[] = [];
  entries.forEach((value, ordinal) => {
    if (!isRecord(value)) return;
    const id = typeof value.id === 'string' ? value.id : undefined;
    if (!id) return;
    const message = isRecord(value.message) ? value.message : undefined;
    const timestamp = message?.timestamp ?? value.timestamp;
    const outlineId = outlineIdentityId(value);
    descriptors.push({
      ordinal,
      id,
      ...(outlineId === undefined ? {} : { outlineId }),
      ...(Object.hasOwn(value, 'parentId') ? { parentId: value.parentId } : {}),
      ...(message?.role === 'user' ? { outlineKind: 'user' as const } : {}),
      ...(message?.role === 'user'
        ? {
            outlineLabel: compactOutlineText(message.content) ?? 'User turn',
          }
        : {}),
      ...(typeof timestamp === 'number' || typeof timestamp === 'string'
        ? { timestamp }
        : {}),
    });
  });
  return branchTopologyFromDescriptors(descriptors, activeLeafId);
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

function lastUserMessageAtFromDescriptors(
  index: SessionHistoryIndex,
  leafId: string | undefined,
): number | undefined {
  if (!leafId) return undefined;
  try {
    const descriptors = branchPageDescriptors(index, leafId).descriptors;
    for (let position = descriptors.length - 1; position >= 0; position -= 1) {
      const value = descriptors[position]?.userMessageAt;
      if (value !== undefined) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resumeMetadataFromDescriptors(
  index: SessionHistoryIndex,
  leafId: string | undefined,
): Pick<
  SessionIndexEntry,
  | 'lastKnownModel'
  | 'lastKnownThinking'
  | 'lastKnownServiceTier'
  | 'lastKnownContextTokens'
> {
  if (!leafId) return {};
  try {
    const descriptors = branchPageDescriptors(index, leafId).descriptors;
    const result: Pick<
      SessionIndexEntry,
      | 'lastKnownModel'
      | 'lastKnownThinking'
      | 'lastKnownServiceTier'
      | 'lastKnownContextTokens'
    > = {};
    for (const descriptor of descriptors) {
      if (descriptor.resume?.model)
        result.lastKnownModel = descriptor.resume.model;
      if (descriptor.resume?.thinking)
        result.lastKnownThinking = descriptor.resume.thinking;
      if (descriptor.resume && 'serviceTier' in descriptor.resume) {
        if (descriptor.resume.serviceTier)
          result.lastKnownServiceTier = descriptor.resume.serviceTier;
        else delete result.lastKnownServiceTier;
      }
      if (descriptor.resume?.contextTokens !== undefined)
        result.lastKnownContextTokens = descriptor.resume.contextTokens;
    }
    return result;
  } catch {
    return {};
  }
}

export class SessionIndex {
  private catalogue: SessionCatalogue = {
    kind: 'live',
    epoch: 0,
    files: new Map(),
    fileIds: new Map(),
    fileRevisions: new Map(),
    pendingMetadata: new Map(),
  };
  private nextCatalogueEpoch = 0;
  /** Live mutations invalidate an in-flight staged rebuild. */
  private liveMutationGeneration = 0;
  /** Rebuilds publish in request order, never in completion order. */
  private rebuildQueue: Promise<void> = Promise.resolve();
  private get files(): Map<string, IndexedFile> {
    return this.catalogue.files;
  }
  private get fileIds(): Map<string, string> {
    return this.catalogue.fileIds;
  }
  private readonly watchers = new Map<
    string,
    ReturnType<typeof import('node:fs').watch>
  >();
  private readonly watcherRetries = new Map<string, NodeJS.Timeout>();
  private readonly scheduled = new Map<string, NodeJS.Timeout>();
  private readonly indexing = new Map<string, Promise<void>>();
  private readonly operations = new Set<Promise<unknown>>();
  private closed = false;
  private closePromise?: Promise<void>;
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
    this.assertOpen();
    const rebuild = this.track(
      this.rebuildQueue.then(() => this.rebuildInternal()),
    );
    this.rebuildQueue = rebuild.catch(() => undefined);
    return rebuild;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Session index is closed.');
  }

  private async rebuildInternal(): Promise<void> {
    if (this.closed) return;
    // Discovery and indexing can pause for filesystem I/O. Keep the previous
    // catalogue live until the complete replacement is ready, then publish it
    // with one synchronous pointer swap.
    while (true) {
      if (this.closed) return;
      const live = this.catalogue;
      const epoch = live.epoch;
      const generation = this.liveMutationGeneration;
      const staged: SessionCatalogue = {
        kind: 'staged',
        epoch: this.nextCatalogueEpoch + 1,
        files: new Map(),
        fileIds: new Map(),
        fileRevisions: new Map(),
        pendingMetadata: new Map(),
      };
      const paths = (
        await Promise.all(
          this.sessionRoots().map((root) => this.findJsonl(root)),
        )
      ).flat();
      for (const file of paths)
        await this.indexFile(file, [], staged).catch(() => undefined);

      // A watcher/index refresh may have committed while this replacement was
      // being built. Retry rather than replacing its newer catalogue with a
      // snapshot from before that commit.
      if (this.closed) return;
      if (
        live !== this.catalogue ||
        epoch !== this.catalogue.epoch ||
        generation !== this.liveMutationGeneration
      )
        continue;
      const published: SessionCatalogue = {
        ...staged,
        kind: 'live',
        epoch: ++this.nextCatalogueEpoch,
        pendingMetadata: new Map(),
      };
      this.catalogue = published;
      this.liveMutationGeneration += 1;
      // Metadata persistence is part of publication, not staging. A discarded
      // scan therefore cannot persist stale headers or titles.
      for (const entry of staged.pendingMetadata.values()) {
        try {
          this.metadata?.saveSession(entry);
        } catch {
          this.removeFile(entry.file, published, published.epoch);
        }
      }
      return;
    }
  }

  async start(): Promise<void> {
    this.assertOpen();
    await this.rebuild();
    await Promise.all(
      this.sessionRoots().map((root) => this.ensureWatcher(root)),
    );
  }

  async refresh(): Promise<void> {
    await this.rebuild();
  }

  private isListed(entry: IndexedFile): boolean {
    return (
      !this.isAuxiliaryFile(entry.file) ||
      (entry.sessionKind === 'delegate' && entry.parentSessionId !== undefined)
    );
  }

  list(): SessionIndexEntry[] {
    return [...this.files.values()]
      .filter((file) => this.isListed(file))
      .map((file) => this.publicEntry(file))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SessionIndexEntry | undefined {
    const entry = this.files.get(id);
    return entry ? this.publicEntry(entry) : undefined;
  }

  getListed(id: string): SessionIndexEntry | undefined {
    const entry = this.files.get(id);
    return entry && this.isListed(entry) ? this.publicEntry(entry) : undefined;
  }

  /** Timestamp used to order recent user activity, optionally on a live leaf. */
  lastUserMessageAt(id: string, leafId?: string): number | undefined {
    const entry = this.files.get(id);
    if (!entry) return undefined;
    return leafId === undefined
      ? entry.lastUserMessageAt
      : lastUserMessageAtFromDescriptors(entry.historyIndex, leafId);
  }

  /** Resume tuple derived from the persisted active branch. */
  resumeMetadata(
    id: string,
    leafId?: string,
  ): Pick<
    SessionIndexEntry,
    'lastKnownModel' | 'lastKnownThinking' | 'lastKnownServiceTier'
  > {
    const entry = this.files.get(id);
    if (!entry) return {};
    if (leafId === undefined)
      return {
        ...(entry.lastKnownModel === undefined
          ? {}
          : { lastKnownModel: entry.lastKnownModel }),
        ...(entry.lastKnownThinking === undefined
          ? {}
          : { lastKnownThinking: entry.lastKnownThinking }),
        ...(entry.lastKnownServiceTier === undefined
          ? {}
          : { lastKnownServiceTier: entry.lastKnownServiceTier }),
      };
    const metadata = resumeMetadataFromDescriptors(entry.historyIndex, leafId);
    return {
      ...(metadata.lastKnownModel === undefined
        ? {}
        : { lastKnownModel: metadata.lastKnownModel }),
      ...(metadata.lastKnownThinking === undefined
        ? {}
        : { lastKnownThinking: metadata.lastKnownThinking }),
      ...(metadata.lastKnownServiceTier === undefined
        ? {}
        : { lastKnownServiceTier: metadata.lastKnownServiceTier }),
    };
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
    // Resolving the latest leaf preserves transcript selection only; it is
    // not proof that this append-only file's latest entry is the active path.
    const branchTopology = branchTopologyForIndex(index, requestedLeaf);
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
      branchTopology,
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
        return {
          ...response,
          outline: indexed.historyIndex.outline,
          branchTopology: branchTopologyFromDescriptors(
            indexed.historyIndex.descriptors,
            requestedLeafId,
          ),
        };
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
      branchTopology: branchTopologyFromDescriptors(
        indexed.historyIndex.descriptors,
      ),
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const retry of this.watcherRetries.values()) clearTimeout(retry);
    this.watcherRetries.clear();
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    await Promise.allSettled([...this.operations]);
    this.indexing.clear();
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

  private ensureWatcher(root: string): Promise<void> {
    return this.track(this.ensureWatcherInternal(root));
  }

  private async ensureWatcherInternal(root: string): Promise<void> {
    if (this.closed || this.watchers.has(root)) return;
    try {
      const fsModule = await import('node:fs');
      if (this.closed) return;
      const watcher = fsModule.watch(
        root,
        { recursive: true },
        (_event, filename) => this.handleWatcherEvent(root, filename),
      );
      this.watchers.set(root, watcher);
      watcher.on('error', () => {
        watcher.close();
        this.watchers.delete(root);
        if (!this.closed) this.scheduleWatcherRetry(root);
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
    if (this.closed) return;
    try {
      this.onChange?.(sessionId, auxiliary);
    } catch {
      // Filesystem observation must never fail because a downstream listener
      // is temporarily unavailable.
    }
  }

  private scheduleWatcherRetry(root: string): void {
    if (this.closed || this.watcherRetries.has(root)) return;
    const retry = setTimeout(() => {
      this.watcherRetries.delete(root);
      if (!this.closed) void this.ensureWatcher(root);
    }, 1_000);
    retry.unref?.();
    this.watcherRetries.set(root, retry);
  }

  private scheduleIndex(file: string): void {
    if (this.closed) return;
    const existing = this.scheduled.get(file);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.scheduled.delete(file);
      if (this.closed) return;
      const previous = this.indexing.get(file) ?? Promise.resolve();
      const previousId = this.fileIds.get(path.resolve(file));
      const next = previous
        .then(async () => {
          const catalogue = this.catalogue;
          const epoch = catalogue.epoch;
          try {
            await this.indexFile(file);
          } catch (error) {
            // Preserve the watcher behavior for a file that changed during its
            // scan, but never remove a catalogue published after that scan
            // began.
            if (error instanceof SessionFileChangedError)
              this.removeFile(file, catalogue, epoch);
          }
        })
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

  private indexFile(
    file: string,
    proofOffsets: readonly number[] = [],
    target?: SessionCatalogue,
  ): Promise<void> {
    return this.track(this.indexFileInternal(file, proofOffsets, target));
  }

  private async indexFileInternal(
    file: string,
    proofOffsets: readonly number[] = [],
    target?: SessionCatalogue,
  ): Promise<void> {
    const resolved = path.resolve(file);
    if (target?.kind === 'staged') {
      const existingId = target.fileIds.get(resolved);
      const existing =
        existingId === undefined ? undefined : target.files.get(existingId);
      await this.indexFileStreaming(
        file,
        proofOffsets.concat(
          existing === undefined
            ? []
            : [...existing.historyIndex.prefixHashes.keys()],
        ),
        target,
        target.epoch,
        undefined,
      );
      return;
    }

    // A live scan can race another scan of the same path or a catalogue swap.
    // Retry against the new live epoch instead of dropping a valid update.
    while (true) {
      const catalogue = this.catalogue;
      const epoch = catalogue.epoch;
      const fileRevision = catalogue.fileRevisions.get(resolved) ?? 0;
      const existingId = catalogue.fileIds.get(resolved);
      const existing =
        existingId === undefined ? undefined : catalogue.files.get(existingId);
      const result = await this.indexFileStreaming(
        file,
        proofOffsets.concat(
          existing === undefined
            ? []
            : [...existing.historyIndex.prefixHashes.keys()],
        ),
        catalogue,
        epoch,
        fileRevision,
      );
      if (result === 'committed' || this.closed) return;
    }
  }

  private async indexFileStreaming(
    file: string,
    proofOffsets: readonly number[],
    catalogue: SessionCatalogue,
    epoch: number,
    fileRevision: number | undefined,
  ): Promise<'committed' | 'discarded'> {
    if (this.closed) return 'discarded';
    const resolved = path.resolve(file);
    if (
      !resolved.endsWith('.jsonl') ||
      !(await this.isSafeSessionFile(resolved))
    ) {
      return this.removeFile(resolved, catalogue, epoch, fileRevision)
        ? 'committed'
        : 'discarded';
    }
    try {
      const scan = await scanSessionFile(
        resolved,
        proofOffsets,
        this.onIndexPendingBytes,
      );
      if (this.closed) return 'discarded';
      const header = scan.header;
      if (!header || typeof header.cwd !== 'string')
        return this.removeFile(resolved, catalogue, epoch, fileRevision)
          ? 'committed'
          : 'discarded';
      const groups = groupTranscript(
        scan.descriptors.map((descriptor) => descriptor.activity),
      );
      const historyIndex: SessionHistoryIndex = {
        ...scan.fileVersion,
        fileHash: scan.fileHash,
        prefixHashes: scan.prefixHashes,
        descriptors: scan.descriptors,
        byId: scan.byId,
        latestEntryId: scan.latestEntryId,
        groups,
        outline: buildSessionOutline(scan.descriptors, groups),
      };
      const id =
        typeof header.id === 'string' ? header.id : this.idForPath(resolved);
      // A scan that began against an older live catalogue must not publish its
      // result after a rebuild swap. Staged rebuild catalogues are explicit and
      // do not use live per-file revisions.
      const current =
        catalogue.kind === 'live' &&
        catalogue === this.catalogue &&
        catalogue.epoch === epoch &&
        (fileRevision === undefined ||
          (catalogue.fileRevisions.get(resolved) ?? 0) === fileRevision);
      if (!current && catalogue.kind === 'live') return 'discarded';
      const previous = catalogue.files.get(id);
      if (previous && previous.file !== resolved) {
        if (
          !this.isAuxiliaryFile(previous.file) &&
          this.isAuxiliaryFile(resolved)
        )
          return 'committed';
        catalogue.fileIds.delete(previous.file);
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
      const lastUserMessageAt = lastUserMessageAtFromDescriptors(
        historyIndex,
        scan.latestEntryId,
      );
      const entry: IndexedFile = {
        id,
        file: resolved,
        cwd: header.cwd,
        ...(auxiliaryDelegate ? { sessionKind: 'delegate' as const } : {}),
        ...(headerParentSessionId
          ? { parentSessionId: headerParentSessionId }
          : {}),
        ...(headerDelegateName ? { name: headerDelegateName } : {}),
        ...(scan.sawSessionInfo && scan.name ? { name: scan.name } : {}),
        title: deriveSessionTitle(
          scan.firstUserEntry === undefined ? [] : [scan.firstUserEntry],
        ),
        startedAt:
          typeof header.timestamp === 'string' &&
          Number.isFinite(Date.parse(header.timestamp))
            ? Date.parse(header.timestamp)
            : scan.fileVersion.birthtimeMs,
        updatedAt: scan.fileVersion.mtimeMs,
        ...(lastUserMessageAt === undefined ? {} : { lastUserMessageAt }),
        ...resumeMetadataFromDescriptors(historyIndex, scan.latestEntryId),
        header,
        lastEntryId: scan.latestEntryId,
        historyIndex,
      };
      const stillCurrent =
        catalogue.kind === 'staged' ||
        (catalogue === this.catalogue &&
          catalogue.epoch === epoch &&
          (fileRevision === undefined ||
            (catalogue.fileRevisions.get(resolved) ?? 0) === fileRevision));
      if (!stillCurrent) return 'discarded';
      const prior = catalogue.files.get(id);
      catalogue.files.set(id, entry);
      catalogue.fileIds.set(resolved, id);
      if (catalogue.kind === 'staged') {
        if (!this.isAuxiliaryFile(resolved))
          catalogue.pendingMetadata.set(id, entry);
      } else {
        if (!this.isAuxiliaryFile(resolved)) this.metadata?.saveSession(entry);
        catalogue.fileRevisions.set(resolved, (fileRevision ?? 0) + 1);
        this.liveMutationGeneration += 1;
      }
      // Preserve the old collision semantics when a prior ID points at a
      // different file, while keeping the live-map commit synchronous.
      if (prior && prior.file !== resolved && prior.file !== '')
        catalogue.fileIds.delete(prior.file);
      return 'committed';
    } catch (error) {
      if (!(error instanceof SessionFileChangedError))
        this.removeFile(resolved, catalogue, epoch, fileRevision);
      throw error;
    }
  }

  private removeFile(
    file: string,
    catalogue: SessionCatalogue = this.catalogue,
    epoch = catalogue.epoch,
    fileRevision?: number,
  ): boolean {
    if (catalogue.kind === 'live') {
      if (
        catalogue !== this.catalogue ||
        catalogue.epoch !== epoch ||
        (fileRevision !== undefined &&
          (catalogue.fileRevisions.get(path.resolve(file)) ?? 0) !==
            fileRevision)
      )
        return false;
    }
    const resolved = path.resolve(file);
    const id = catalogue.fileIds.get(resolved);
    catalogue.fileIds.delete(resolved);
    if (id && catalogue.files.get(id)?.file === resolved)
      catalogue.files.delete(id);
    if (id && catalogue.pendingMetadata.get(id)?.file === resolved)
      catalogue.pendingMetadata.delete(id);
    if (catalogue.kind === 'live') {
      catalogue.fileRevisions.set(
        resolved,
        (catalogue.fileRevisions.get(resolved) ?? 0) + 1,
      );
      this.liveMutationGeneration += 1;
    }
    // `true` means the requested catalogue/epoch was still authoritative,
    // including when the file was already absent.
    return true;
  }
}
