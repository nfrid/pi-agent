import { randomBytes } from 'node:crypto';

export interface FeedBounds {
  readonly replayCount: number;
  readonly replayBytes: number;
  readonly subscriberQueueCount: number;
  readonly subscriberQueueBytes: number;
  readonly maxFrameBytes?: number;
}

export interface FeedRecord<TEvent> {
  readonly id: string;
  readonly sequence: number;
  readonly event: TEvent;
  readonly bytes: number;
  readonly key?: string;
}

export interface FeedSnapshotRecord<TSnapshot> {
  readonly kind: 'snapshot';
  readonly id: string;
  readonly sequence: number;
  readonly snapshot: TSnapshot;
}

export interface FeedEventRecord<TEvent> {
  readonly kind: 'event';
  readonly id: string;
  readonly sequence: number;
  readonly event: TEvent;
  readonly key?: string;
}

export interface FeedCaughtUpRecord {
  readonly kind: 'caught-up';
  readonly id: string;
  readonly sequence: number;
}

export type FeedItem<TSnapshot, TEvent> =
  | FeedSnapshotRecord<TSnapshot>
  | FeedEventRecord<TEvent>
  | FeedCaughtUpRecord;

export interface FeedSubscriptionOptions<TSnapshot> {
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
  /** Build state at exactly `sequence`; publication continues while this awaits. */
  readonly buildSnapshot: (sequence: number) => TSnapshot | Promise<TSnapshot>;
}

export const FEED_SNAPSHOT_FALLBACK_REASONS = [
  'initial',
  'invalid',
  'foreign',
  'future',
  'expired',
  'unavailable',
  'too-large',
] as const;
export type FeedSnapshotFallbackReason =
  (typeof FEED_SNAPSHOT_FALLBACK_REASONS)[number];
export type FeedSnapshotFallbacks = Readonly<
  Record<FeedSnapshotFallbackReason, number>
>;

export interface FeedMetrics {
  readonly generation: string;
  readonly feed: string;
  readonly sequence: number;
  readonly subscribers: number;
  readonly subscriptionOpens: number;
  readonly resumedSubscriptions: number;
  readonly replayCount: number;
  readonly replayBytes: number;
  readonly replayCountLimit: number;
  readonly replayBytesLimit: number;
  readonly queueCountLimit: number;
  readonly queueBytesLimit: number;
  readonly maxFrameBytes: number;
  readonly oldestSequence?: number;
  readonly newestSequence?: number;
  readonly oldestCursor?: string;
  readonly newestCursor?: string;
  readonly queuedCount: number;
  readonly queuedBytes: number;
  readonly coalesced: number;
  readonly overflowTerminations: number;
  readonly oversizedTerminations: number;
  readonly largestFrameBytes: number;
  readonly unavailableThroughSequence?: number;
  readonly snapshotFallbacks: FeedSnapshotFallbacks;
}

export class FeedOverflowError extends Error {
  readonly retryable = true;
  constructor(message = 'The live feed subscriber queue overflowed.') {
    super(message);
    this.name = 'FeedOverflowError';
  }
}

export class FeedPayloadTooLargeError extends Error {
  readonly retryable = false;
  constructor(message = 'The live feed payload exceeds its frame limit.') {
    super(message);
    this.name = 'FeedPayloadTooLargeError';
  }
}

type CursorFrame = 'checkpoint' | 'snapshot' | 'event' | 'caught-up';

interface Cursor {
  readonly generation: string;
  readonly feed: string;
  readonly sequence: number;
  /** Absent only on cursors issued before frame identities were introduced. */
  readonly frame?: CursorFrame;
}

interface Subscriber<TSnapshot, TEvent> {
  readonly queue: Array<FeedItem<TSnapshot, TEvent>>;
  queueBytes: number;
  handoff: boolean;
  deferred: FeedEventRecord<TEvent>[];
  deferredBytes: number;
  waiting?: {
    resolve: (item: FeedItem<TSnapshot, TEvent>) => void;
    reject: (error: Error) => void;
  };
  closed: boolean;
  error?: Error;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): Cursor | undefined {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const cursor = JSON.parse(decoded) as Partial<Cursor>;
    const sequence = cursor.sequence;
    if (
      typeof cursor.generation !== 'string' ||
      typeof cursor.feed !== 'string' ||
      !Number.isSafeInteger(sequence) ||
      sequence === undefined ||
      sequence < 0
    )
      return undefined;
    const frame = cursor.frame;
    if (
      frame !== undefined &&
      frame !== 'checkpoint' &&
      frame !== 'snapshot' &&
      frame !== 'event' &&
      frame !== 'caught-up'
    )
      return undefined;
    const normalized: Cursor = {
      generation: cursor.generation,
      feed: cursor.feed,
      sequence,
      ...(frame === undefined ? {} : { frame }),
    };
    if (encodeCursor(normalized) !== value) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

/**
 * A synchronous publisher with bounded replay and bounded per-consumer
 * queues. The only resumable value is the opaque tracked ID; the numeric
 * sequence is deliberately local bookkeeping and is never accepted as a
 * cursor by itself.
 */
export class BoundedFeed<TSnapshot, TEvent> {
  readonly generation: string;
  readonly feed: string;
  private sequenceValue = 0;
  private records: FeedRecord<TEvent>[] = [];
  private replayBytesValue = 0;
  /**
   * The latest cursor that predates a coalesced or rejected publication.
   * Keeping one boundary is deliberately conservative and O(1): cursors at
   * or before it rebase, while a later authoritative snapshot can resume.
   */
  private unavailableThroughSequence?: number;
  private readonly subscribers = new Set<Subscriber<TSnapshot, TEvent>>();
  private coalescedValue = 0;
  private overflowTerminationsValue = 0;
  private oversizedTerminationsValue = 0;
  private subscriptionOpensValue = 0;
  private resumedSubscriptionsValue = 0;
  private largestFrameBytesValue = 0;
  private readonly snapshotFallbacksValue: Record<
    FeedSnapshotFallbackReason,
    number
  > = {
    initial: 0,
    invalid: 0,
    foreign: 0,
    future: 0,
    expired: 0,
    unavailable: 0,
    'too-large': 0,
  };
  private closed = false;
  private readonly maxFrameBytes: number;

  constructor(
    feed: string,
    bounds: FeedBounds,
    generation = randomBytes(16).toString('base64url'),
  ) {
    if (!feed || !/^[A-Za-z0-9._-]{1,128}$/.test(feed))
      throw new Error('Feed key must be a bounded identifier.');
    for (const [name, value] of Object.entries(bounds)) {
      if (name === 'maxFrameBytes' && value === undefined) continue;
      if (!Number.isSafeInteger(value) || (value as number) < 1)
        throw new Error(`Feed bound ${name} must be a positive integer.`);
    }
    this.feed = feed;
    this.generation = generation;
    this.replayCount = bounds.replayCount;
    this.replayByteLimit = bounds.replayBytes;
    this.queueCount = bounds.subscriberQueueCount;
    this.queueByteLimit = bounds.subscriberQueueBytes;
    this.maxFrameBytes = bounds.maxFrameBytes ?? 2 * 1024 * 1024;
  }

  private readonly replayCount: number;
  private readonly replayByteLimit: number;
  private readonly queueCount: number;
  private readonly queueByteLimit: number;

  get sequence(): number {
    return this.sequenceValue;
  }

  get currentId(): string {
    return this.id(this.sequenceValue, 'checkpoint');
  }

  metrics(): FeedMetrics {
    let queuedCount = 0;
    let queuedBytes = 0;
    for (const subscriber of this.subscribers) {
      queuedCount += subscriber.queue.length + subscriber.deferred.length;
      queuedBytes += subscriber.queueBytes + subscriber.deferredBytes;
    }
    const oldest = this.records[0];
    const newest = this.records.at(-1);
    return {
      generation: this.generation,
      feed: this.feed,
      sequence: this.sequenceValue,
      subscribers: this.subscribers.size,
      subscriptionOpens: this.subscriptionOpensValue,
      resumedSubscriptions: this.resumedSubscriptionsValue,
      replayCount: this.records.length,
      replayBytes: this.replayBytesValue,
      replayCountLimit: this.replayCount,
      replayBytesLimit: this.replayByteLimit,
      queueCountLimit: this.queueCount,
      queueBytesLimit: this.queueByteLimit,
      maxFrameBytes: this.maxFrameBytes,
      ...(oldest === undefined
        ? {}
        : { oldestSequence: oldest.sequence, oldestCursor: oldest.id }),
      ...(newest === undefined
        ? {}
        : { newestSequence: newest.sequence, newestCursor: newest.id }),
      queuedCount,
      queuedBytes,
      coalesced: this.coalescedValue,
      overflowTerminations: this.overflowTerminationsValue,
      oversizedTerminations: this.oversizedTerminationsValue,
      largestFrameBytes: this.largestFrameBytesValue,
      ...(this.unavailableThroughSequence === undefined
        ? {}
        : { unavailableThroughSequence: this.unavailableThroughSequence }),
      snapshotFallbacks: { ...this.snapshotFallbacksValue },
    };
  }

  /** Publish even when there are no subscribers; replay retention is feed-owned. */
  publish(event: TEvent, options: { key?: string } = {}): FeedRecord<TEvent> {
    if (this.closed) throw new Error('Feed is closed.');
    const sequence = ++this.sequenceValue;
    const record: FeedRecord<TEvent> = {
      id: this.id(sequence, 'event'),
      sequence,
      event,
      bytes: bytes(event),
      ...(options.key === undefined ? {} : { key: options.key }),
    };
    this.noteFrameBytes(record.bytes);
    if (record.bytes > this.maxFrameBytes) {
      // The sequence is intentionally consumed. Existing subscribers must not
      // remain connected across an event that cannot be represented; their
      // retryable termination causes tRPC to resume with a snapshot because
      // this sequence is permanently unavailable.
      this.markUnavailable(sequence);
      this.oversizedTerminationsValue += this.subscribers.size;
      this.terminateSubscribers(new FeedOverflowError());
      throw new FeedPayloadTooLargeError();
    }

    if (record.key !== undefined) {
      const index = this.records.findIndex((item) => item.key === record.key);
      if (index >= 0) {
        const previous = this.records.splice(index, 1)[0];
        if (previous) {
          this.replayBytesValue -= previous.bytes;
          this.markUnavailable(previous.sequence);
          this.coalescedValue += 1;
        }
      }
    }
    // A coalesced replacement is appended at its sequence, never left in the
    // old slot. This keeps retained records physically ordered.
    this.append(record);
    for (const subscriber of [...this.subscribers])
      this.deliver(subscriber, record);
    return record;
  }

  private append(record: FeedRecord<TEvent>): void {
    this.records.push(record);
    this.replayBytesValue += record.bytes;
    while (
      this.records.length > this.replayCount ||
      this.replayBytesValue > this.replayByteLimit
    ) {
      const removed = this.records.shift();
      if (!removed) break;
      this.replayBytesValue -= removed.bytes;
    }
  }

  private markUnavailable(sequence: number): void {
    const through = Math.max(0, sequence - 1);
    this.unavailableThroughSequence =
      this.unavailableThroughSequence === undefined
        ? through
        : Math.max(this.unavailableThroughSequence, through);
  }

  private isUnavailable(sequence: number): boolean {
    return (
      this.unavailableThroughSequence !== undefined &&
      sequence <= this.unavailableThroughSequence
    );
  }

  private recordFallback(reason: FeedSnapshotFallbackReason): void {
    this.snapshotFallbacksValue[reason] += 1;
  }

  private id(sequence: number, frame: CursorFrame): string {
    return encodeCursor({
      generation: this.generation,
      feed: this.feed,
      sequence,
      frame,
    });
  }

  private replayAfter(sequence: number): FeedRecord<TEvent>[] | undefined {
    const oldest = this.records[0]?.sequence ?? this.sequenceValue + 1;
    if (sequence < oldest - 1 || sequence > this.sequenceValue)
      return undefined;
    // A cursor before a coalesced/rejected publication cannot prove that it
    // saw every later record. The missing sequence itself is a safe boundary:
    // a live client may have observed it, and a rejected publication can only
    // issue that cursor through an authoritative snapshot.
    if (this.isUnavailable(sequence)) return undefined;
    const replay = this.records.filter((record) => record.sequence > sequence);
    let expected = sequence + 1;
    for (const record of replay) {
      if (record.sequence !== expected) return undefined;
      expected += 1;
    }
    // The latest sequence must also be represented. This catches one missing
    // event after a cursor, including an oversized publication.
    if (expected !== this.sequenceValue + 1) return undefined;
    return replay;
  }

  /**
   * Register before awaiting the snapshot builder. Publications made during
   * that await are queued and drained after the pinned snapshot, followed by
   * one explicit caught-up marker.
   */
  async *subscribe(
    options: FeedSubscriptionOptions<TSnapshot>,
  ): AsyncGenerator<FeedItem<TSnapshot, TEvent>> {
    if (this.closed) return;
    this.subscriptionOpensValue += 1;
    if (options.lastEventId !== undefined) this.resumedSubscriptionsValue += 1;
    const subscriber: Subscriber<TSnapshot, TEvent> = {
      queue: [],
      queueBytes: 0,
      handoff: true,
      deferred: [],
      deferredBytes: 0,
      closed: false,
    };
    this.subscribers.add(subscriber);
    const abort = () =>
      this.closeSubscriber(subscriber, new Error('Subscription aborted.'));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });

    try {
      let seed: FeedRecord<TEvent>[] | undefined;
      let fallbackReason: FeedSnapshotFallbackReason | undefined;
      if (options.lastEventId === undefined) fallbackReason = 'initial';
      else {
        const cursor = decodeCursor(options.lastEventId);
        if (!cursor) fallbackReason = 'invalid';
        else if (
          cursor.generation !== this.generation ||
          cursor.feed !== this.feed
        )
          fallbackReason = 'foreign';
        else if (cursor.sequence > this.sequenceValue)
          fallbackReason = 'future';
        else {
          const oldest = this.records[0]?.sequence ?? this.sequenceValue + 1;
          if (cursor.sequence < oldest - 1) fallbackReason = 'expired';
          else if (this.isUnavailable(cursor.sequence))
            fallbackReason = 'unavailable';
          else {
            seed = this.replayAfter(cursor.sequence);
            if (seed === undefined) fallbackReason = 'unavailable';
          }
        }
      }
      const caughtUpBytes = bytes({
        kind: 'caught-up',
        sequence: this.sequenceValue,
      });
      if (seed !== undefined && this.fits(seed, caughtUpBytes)) {
        for (const record of seed)
          this.enqueue(subscriber, this.eventItem(record));
        subscriber.handoff = false;
      } else {
        if (seed !== undefined) fallbackReason = 'too-large';
        this.recordFallback(fallbackReason ?? 'unavailable');
        // Invalid, foreign, future, expired, unavailable, or too-large replay
        // is a normal recovery path: one authoritative snapshot, never a
        // reconnect loop.
        const sequence = this.sequenceValue;
        const snapshot = await options.buildSnapshot(sequence);
        if (subscriber.closed) {
          if (subscriber.error instanceof FeedOverflowError)
            throw subscriber.error;
          return;
        }
        const item: FeedSnapshotRecord<TSnapshot> = {
          kind: 'snapshot',
          id: this.id(sequence, 'snapshot'),
          sequence,
          snapshot,
        };
        const snapshotBytes = this.itemBytes(item);
        if (snapshotBytes > this.maxFrameBytes)
          throw new FeedPayloadTooLargeError(
            'The authoritative snapshot exceeds the feed frame limit.',
          );
        if (
          subscriber.deferred.length + 2 > this.queueCount ||
          snapshotBytes + subscriber.deferredBytes + caughtUpBytes >
            this.queueByteLimit
        ) {
          this.closeSubscriber(subscriber, new FeedOverflowError());
          throw subscriber.error ?? new FeedOverflowError();
        }
        subscriber.handoff = false;
        this.enqueue(subscriber, item);
        for (const deferred of subscriber.deferred)
          this.enqueue(subscriber, deferred);
        subscriber.deferred = [];
        subscriber.deferredBytes = 0;
      }
      this.enqueue(subscriber, {
        kind: 'caught-up',
        id: this.id(this.sequenceValue, 'caught-up'),
        sequence: this.sequenceValue,
      });

      while (!subscriber.closed) {
        const item = await this.next(subscriber);
        yield item;
        // A producer may overflow and close the queue while the consumer is
        // paused at the preceding yield. Propagate retryable overflow instead
        // of silently completing the async generator.
        if (subscriber.closed && subscriber.error instanceof FeedOverflowError)
          throw subscriber.error;
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.removeSubscriber(subscriber);
    }
  }

  private fits(
    items: readonly { bytes?: number; snapshot?: unknown; event?: unknown }[],
    extraBytes = 0,
  ): boolean {
    const count = items.length + 1;
    let total = extraBytes;
    for (const item of items)
      total += item.bytes ?? bytes(item.snapshot ?? item.event ?? item);
    return count <= this.queueCount && total <= this.queueByteLimit;
  }

  private eventItem(record: FeedRecord<TEvent>): FeedEventRecord<TEvent> {
    return {
      kind: 'event',
      id: record.id,
      sequence: record.sequence,
      event: record.event,
      ...(record.key === undefined ? {} : { key: record.key }),
    };
  }

  private noteFrameBytes(value: number): void {
    this.largestFrameBytesValue = Math.max(this.largestFrameBytesValue, value);
  }

  private itemBytes(item: FeedItem<TSnapshot, TEvent>): number {
    const value = bytes(
      item.kind === 'snapshot'
        ? item.snapshot
        : item.kind === 'event'
          ? item.event
          : item,
    );
    this.noteFrameBytes(value);
    return value;
  }

  private enqueue(
    subscriber: Subscriber<TSnapshot, TEvent>,
    item: FeedItem<TSnapshot, TEvent>,
  ): void {
    if (subscriber.closed) return;
    const itemBytes = this.itemBytes(item);
    if (subscriber.waiting) {
      const waiter = subscriber.waiting;
      subscriber.waiting = undefined;
      waiter.resolve(item);
      return;
    }
    subscriber.queue.push(item);
    subscriber.queueBytes += itemBytes;
    if (
      subscriber.queue.length > this.queueCount ||
      subscriber.queueBytes > this.queueByteLimit
    ) {
      this.overflowTerminationsValue += 1;
      this.closeSubscriber(subscriber, new FeedOverflowError());
    }
  }

  private deliver(
    subscriber: Subscriber<TSnapshot, TEvent>,
    record: FeedRecord<TEvent>,
  ): void {
    if (subscriber.closed) return;
    const item = this.eventItem(record);
    if (subscriber.handoff) {
      // Never coalesce a queued item: replacing it would expose a sequence
      // gap to the client and cannot be repaired without a rebase snapshot.
      subscriber.deferred.push(item);
      subscriber.deferredBytes += this.itemBytes(item);
      if (
        subscriber.deferred.length + subscriber.queue.length + 1 >
          this.queueCount ||
        subscriber.deferredBytes + subscriber.queueBytes > this.queueByteLimit
      ) {
        this.overflowTerminationsValue += 1;
        this.closeSubscriber(subscriber, new FeedOverflowError());
      }
      return;
    }
    // Queue every published sequence. Keyed coalescing is replay-only; doing
    // it here would make a connected client observe an unrecoverable gap.
    this.enqueue(subscriber, item);
  }

  private next(
    subscriber: Subscriber<TSnapshot, TEvent>,
  ): Promise<FeedItem<TSnapshot, TEvent>> {
    if (subscriber.queue.length > 0) {
      const item = subscriber.queue.shift() as FeedItem<TSnapshot, TEvent>;
      subscriber.queueBytes -= this.itemBytes(item);
      return Promise.resolve(item);
    }
    if (subscriber.closed)
      return Promise.reject(
        subscriber.error ?? new Error('Subscription closed.'),
      );
    return new Promise((resolve, reject) => {
      subscriber.waiting = { resolve, reject };
    });
  }

  private closeSubscriber(
    subscriber: Subscriber<TSnapshot, TEvent>,
    error?: Error,
  ): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.error = error;
    subscriber.queue.length = 0;
    subscriber.queueBytes = 0;
    subscriber.deferred.length = 0;
    subscriber.deferredBytes = 0;
    if (subscriber.waiting) {
      const waiting = subscriber.waiting;
      subscriber.waiting = undefined;
      waiting.reject(error ?? new Error('Subscription closed.'));
    }
    this.subscribers.delete(subscriber);
  }

  private removeSubscriber(subscriber: Subscriber<TSnapshot, TEvent>): void {
    if (!subscriber.closed) this.closeSubscriber(subscriber);
  }

  private terminateSubscribers(error: Error): void {
    for (const subscriber of [...this.subscribers])
      this.closeSubscriber(subscriber, error);
  }

  close(): void {
    this.closed = true;
    for (const subscriber of [...this.subscribers])
      this.closeSubscriber(subscriber, new Error('Feed closed.'));
    this.records = [];
    this.replayBytesValue = 0;
  }
}

export function decodeFeedId(value: string):
  | {
      generation: string;
      feed: string;
      sequence: number;
      frame?: CursorFrame;
    }
  | undefined {
  return decodeCursor(value);
}
