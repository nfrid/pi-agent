import type { TranscriptProjection } from '@pi-dashboard/domain';
import type { AuthoritativeSessionSnapshot } from '@pi-dashboard/protocol';
import { tryParseAuthoritativeSessionSnapshot } from '@pi-dashboard/protocol';
import type { SessionHistoryCoverage } from './session-transcript-state.js';

/** The on-disk format is deliberately bumped rather than migrated in place. */
export const SESSION_TRANSCRIPT_CACHE_VERSION = 1 as const;
export const DEFAULT_SESSION_TRANSCRIPT_CACHE_LIMIT = 8;

export interface CachedSessionTranscript {
  version: typeof SESSION_TRANSCRIPT_CACHE_VERSION;
  serverId: string;
  sessionId: string;
  savedAt: number;
  /** The last session-feed sequence accepted by the client. */
  acceptedSequence: number;
  snapshot: AuthoritativeSessionSnapshot;
  projection: TranscriptProjection;
  coverage?: SessionHistoryCoverage;
}

export interface SessionTranscriptCache {
  load(sessionId: string): Promise<CachedSessionTranscript | undefined>;
  save(value: CachedSessionTranscript): Promise<void>;
  remove(sessionId: string): Promise<void>;
  prune(): Promise<void>;
}

export interface DecodeCachedSessionTranscriptOptions {
  expectedServerId?: string;
  expectedSessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTranscriptCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= -1;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalTimestamp(
  value: unknown,
): value is number | string | undefined {
  return (
    value === undefined ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function validTranscriptItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'message') {
    return (
      typeof value.messageId === 'string' &&
      typeof value.role === 'string' &&
      isOptionalTimestamp(value.timestamp) &&
      isOptionalString(value.turnId) &&
      (value.toolCallIds === undefined || isStringArray(value.toolCallIds)) &&
      (value.deliveryMode === undefined ||
        value.deliveryMode === 'steer' ||
        value.deliveryMode === 'followUp') &&
      (value.status === 'streaming' || value.status === 'finished')
    );
  }
  if (value.kind === 'tool') {
    return (
      typeof value.toolCallId === 'string' &&
      typeof value.name === 'string' &&
      isOptionalTimestamp(value.timestamp) &&
      isOptionalString(value.turnId) &&
      (value.isError === undefined || typeof value.isError === 'boolean') &&
      (value.status === 'streaming' ||
        value.status === 'pending' ||
        value.status === 'running' ||
        value.status === 'finished' ||
        value.status === 'error')
    );
  }
  return value.kind === 'other' && typeof value.id === 'string';
}

function validProjection(
  value: unknown,
  sessionId: string,
): value is TranscriptProjection {
  if (!isRecord(value)) return false;
  if (value.sessionId !== undefined && value.sessionId !== sessionId)
    return false;
  if (
    !isStringArray(value.order) ||
    !isRecord(value.items) ||
    !isTranscriptCursor(value.lastCursor) ||
    !isTranscriptCursor(value.lastRuntimeSeq) ||
    !isStringArray(value.retiredEpochs) ||
    !isOptionalString(value.sessionId) ||
    !isOptionalString(value.runtimeEpoch)
  )
    return false;
  const items = value.items as Record<string, unknown>;
  const itemIds = Object.keys(items);
  return (
    value.order.every(
      (id) => itemIds.includes(id) && validTranscriptItem(items[id]),
    ) && itemIds.every((id) => validTranscriptItem(items[id]))
  );
}

function validCoverage(
  value: unknown,
  serverId: string,
): value is SessionHistoryCoverage {
  if (!isRecord(value)) return false;
  if (
    !isOptionalString(value.serverId) ||
    (value.serverId !== undefined && value.serverId !== serverId) ||
    !isNonNegativeInteger(value.generation) ||
    !isOptionalString(value.runtimeEpoch) ||
    value.version !== 1 ||
    !isNonNegativeInteger(value.coveredStart) ||
    !isNonNegativeInteger(value.coveredEnd) ||
    typeof value.hasOlder !== 'boolean' ||
    (value.nextBefore !== undefined &&
      (typeof value.nextBefore !== 'string' ||
        value.nextBefore.length === 0)) ||
    (value.leadingContinuation !== undefined &&
      typeof value.leadingContinuation !== 'boolean') ||
    !Array.isArray(value.pages) ||
    !isNonNegativeInteger(value.pageCount) ||
    !isNonNegativeInteger(value.entryCount) ||
    !isNonNegativeInteger(value.byteCount) ||
    value.pageCount !== value.pages.length
  )
    return false;
  return value.pages.every((page) => {
    if (!isRecord(page)) return false;
    return (
      isNonNegativeInteger(page.start) &&
      isNonNegativeInteger(page.end) &&
      typeof page.hasOlder === 'boolean' &&
      (page.nextBefore === undefined ||
        (typeof page.nextBefore === 'string' && page.nextBefore.length > 0)) &&
      (page.leadingContinuation === undefined ||
        typeof page.leadingContinuation === 'boolean') &&
      isStringArray(page.entryIds) &&
      isNonNegativeInteger(page.entryCount) &&
      isNonNegativeInteger(page.byteCount)
    );
  });
}

/**
 * Decode untrusted storage data. In particular, a cache from a previous
 * daemon generation is not usable even when its session ID happens to match.
 */
export function decodeCachedSessionTranscript(
  value: unknown,
  options: DecodeCachedSessionTranscriptOptions = {},
): CachedSessionTranscript | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== SESSION_TRANSCRIPT_CACHE_VERSION ||
    typeof value.serverId !== 'string' ||
    value.serverId.length === 0 ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    !(typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)) ||
    !isNonNegativeInteger(value.acceptedSequence) ||
    (options.expectedServerId !== undefined &&
      value.serverId !== options.expectedServerId) ||
    (options.expectedSessionId !== undefined &&
      value.sessionId !== options.expectedSessionId)
  )
    return undefined;

  const snapshot = tryParseAuthoritativeSessionSnapshot(value.snapshot);
  if (
    !snapshot ||
    snapshot.serverId !== value.serverId ||
    snapshot.metadata.id !== value.sessionId ||
    !validProjection(value.projection, value.sessionId) ||
    (value.coverage !== undefined &&
      !validCoverage(value.coverage, value.serverId))
  )
    return undefined;

  return {
    version: SESSION_TRANSCRIPT_CACHE_VERSION,
    serverId: value.serverId,
    sessionId: value.sessionId,
    savedAt: value.savedAt,
    acceptedSequence: value.acceptedSequence,
    snapshot,
    projection: value.projection,
    ...(value.coverage === undefined ? {} : { coverage: value.coverage }),
  };
}

export interface InMemorySessionTranscriptCacheOptions {
  maxEntries?: number;
  serverId?: string;
}

/** Small synchronous-state backend used by tests and non-browser consumers. */
export class InMemorySessionTranscriptCache implements SessionTranscriptCache {
  private readonly values = new Map<string, CachedSessionTranscript>();
  private readonly maxEntries: number;
  private readonly serverId?: string;

  constructor(options: InMemorySessionTranscriptCacheOptions = {}) {
    this.maxEntries =
      options.maxEntries ?? DEFAULT_SESSION_TRANSCRIPT_CACHE_LIMIT;
    this.serverId = options.serverId;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1)
      throw new Error('maxEntries must be a positive integer');
  }

  async load(sessionId: string): Promise<CachedSessionTranscript | undefined> {
    const value = this.values.get(sessionId);
    if (!value) return undefined;
    const decoded = decodeCachedSessionTranscript(value, {
      expectedSessionId: sessionId,
      expectedServerId: this.serverId,
    });
    if (!decoded) {
      this.values.delete(sessionId);
      return undefined;
    }
    // Map insertion order is the access order used for this LRU backend.
    this.values.delete(sessionId);
    this.values.set(sessionId, decoded);
    return decoded;
  }

  async save(value: CachedSessionTranscript): Promise<void> {
    const decoded = decodeCachedSessionTranscript(value, {
      expectedSessionId: value.sessionId,
      expectedServerId: this.serverId,
    });
    if (!decoded) throw new TypeError('Invalid cached session transcript');
    this.values.delete(decoded.sessionId);
    this.values.set(decoded.sessionId, decoded);
    await this.prune();
  }

  async remove(sessionId: string): Promise<void> {
    this.values.delete(sessionId);
  }

  async prune(): Promise<void> {
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.values.delete(oldest);
    }
  }
}

export interface IndexedDbSessionTranscriptCacheOptions
  extends InMemorySessionTranscriptCacheOptions {
  databaseName?: string;
  storeName?: string;
  indexedDB?: IDBFactory;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** IndexedDB backend. Values are decoded again on read because storage is untrusted. */
export class IndexedDbSessionTranscriptCache implements SessionTranscriptCache {
  private readonly factory: IDBFactory;
  private readonly databaseName: string;
  private readonly storeName: string;
  private readonly maxEntries: number;
  private readonly serverId?: string;
  private databasePromise?: Promise<IDBDatabase>;

  constructor(options: IndexedDbSessionTranscriptCacheOptions = {}) {
    const factory =
      options.indexedDB ??
      (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) throw new Error('IndexedDB is not available');
    this.factory = factory;
    this.databaseName = options.databaseName ?? 'pi-dashboard';
    this.storeName = options.storeName ?? 'session-transcript-cache';
    this.maxEntries =
      options.maxEntries ?? DEFAULT_SESSION_TRANSCRIPT_CACHE_LIMIT;
    this.serverId = options.serverId;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1)
      throw new Error('maxEntries must be a positive integer');
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(this.storeName))
          database.createObjectStore(this.storeName, { keyPath: 'sessionId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return this.databasePromise;
  }

  async load(sessionId: string): Promise<CachedSessionTranscript | undefined> {
    const database = await this.open();
    const transaction = database.transaction(this.storeName, 'readonly');
    const value = await requestResult<unknown>(
      transaction.objectStore(this.storeName).get(sessionId),
    );
    const decoded = decodeCachedSessionTranscript(value, {
      expectedSessionId: sessionId,
      expectedServerId: this.serverId,
    });
    if (!decoded && value !== undefined) await this.remove(sessionId);
    return decoded;
  }

  async save(value: CachedSessionTranscript): Promise<void> {
    const decoded = decodeCachedSessionTranscript(value, {
      expectedSessionId: value.sessionId,
      expectedServerId: this.serverId,
    });
    if (!decoded) throw new TypeError('Invalid cached session transcript');
    const database = await this.open();
    const transaction = database.transaction(this.storeName, 'readwrite');
    await requestResult(transaction.objectStore(this.storeName).put(decoded));
    await this.prune();
  }

  async remove(sessionId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(this.storeName, 'readwrite');
    await requestResult(
      transaction.objectStore(this.storeName).delete(sessionId),
    );
  }

  async prune(): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(this.storeName, 'readonly');
    const values = (
      await requestResult<unknown[]>(
        transaction.objectStore(this.storeName).getAll(),
      )
    )
      .map((value) =>
        decodeCachedSessionTranscript(value, {
          expectedServerId: this.serverId,
        }),
      )
      .filter((value): value is CachedSessionTranscript => value !== undefined)
      .sort(
        (left, right) =>
          left.savedAt - right.savedAt ||
          left.sessionId.localeCompare(right.sessionId),
      );
    const excess = values.slice(
      0,
      Math.max(0, values.length - this.maxEntries),
    );
    for (const value of excess) await this.remove(value.sessionId);
  }
}

export function createSessionTranscriptCache(
  options: IndexedDbSessionTranscriptCacheOptions = {},
): SessionTranscriptCache {
  const factory =
    options.indexedDB ??
    (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
  return factory
    ? new IndexedDbSessionTranscriptCache({ ...options, indexedDB: factory })
    : new InMemorySessionTranscriptCache(options);
}
