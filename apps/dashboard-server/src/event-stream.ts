import type {
  BridgeEvent,
  BrowserSnapshot,
  NotificationEvent,
} from '@pi-dashboard/protocol';

export interface DashboardEventStreamEnvelope {
  readonly cursor: number;
  readonly emittedAt: number;
  readonly runtimeId?: string;
  readonly runtimeEpoch?: string;
  readonly runtimeSeq?: number;
  readonly sessionId?: string;
  readonly notification?: NotificationEvent;
  readonly event: BridgeEvent;
  readonly snapshot?: BrowserSnapshot;
}

export interface DashboardSnapshotStreamRecord {
  readonly type: 'snapshot';
  readonly cursor: number;
  readonly emittedAt: number;
  readonly snapshot: BrowserSnapshot;
}

export type DashboardEventStreamRecord =
  | DashboardEventStreamEnvelope
  | DashboardSnapshotStreamRecord;

export interface ReplayWindow {
  readonly currentCursor: number;
  readonly oldestCursor: number;
  readonly events: readonly DashboardEventStreamRecord[];
  readonly gap: boolean;
}

type Subscriber = (record: DashboardEventStreamRecord) => void;

/**
 * The one daemon-global clock and bounded replay log used by browser streams.
 * Publication is synchronous: a cursor is allocated before subscribers see an
 * item, so a subscriber can never observe two records with the same cursor.
 */
export class DashboardEventStream {
  private cursorValue = 0;
  private readonly records: DashboardEventStreamRecord[] = [];
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly limit = 256) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Event stream limit must be a positive integer.');
  }

  get cursor(): number {
    return this.cursorValue;
  }

  get oldestCursor(): number {
    return this.records[0]?.cursor ?? this.cursorValue + 1;
  }

  publish(
    factory: (cursor: number, emittedAt: number) => DashboardEventStreamRecord,
  ): DashboardEventStreamRecord {
    const cursor = ++this.cursorValue;
    const record = factory(cursor, Date.now());
    if (record.cursor !== cursor)
      throw new Error('Event stream factory returned the wrong cursor.');
    this.records.push(record);
    while (this.records.length > this.limit) this.records.shift();
    for (const subscriber of this.subscribers) subscriber(record);
    return record;
  }

  replayAfter(cursor: number): ReplayWindow {
    // Cursors are scoped to this daemon generation. A client asking for a
    // future cursor has connected to a restarted daemon and must resync rather
    // than wait forever for an event that can never arrive.
    const gap = cursor < this.oldestCursor - 1 || cursor > this.cursorValue;
    return {
      currentCursor: this.cursorValue,
      oldestCursor: this.oldestCursor,
      events: gap
        ? []
        : this.records.filter((record) => record.cursor > cursor),
      gap,
    };
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  close(): void {
    this.subscribers.clear();
  }
}
