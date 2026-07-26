import { waitFor, withAbort } from './async';

/**
 * The bookkeeping every long-running job in this repo needs: an id, a state,
 * and a promise that resolves once it has settled.
 */
export interface JobRecord<TState> {
  readonly id: string;
  readonly createdAt: number;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  state: TState;
  settledAt?: number;
  /** How many callers are currently awaiting this record's settlement. */
  observers: number;
}

export interface AsyncJobRegistryOptions<
  TState,
  TRecord extends JobRecord<TState>,
  TSnapshot,
> {
  /** Prefix for minted ids, e.g. `bg` yields `bg-1`, `bg-2`. */
  idPrefix: string;
  /** How a record is named in error messages, e.g. `background process`. */
  label: string;
  maxActive: number;
  maxSettled: number;
  isActive: (state: TState) => boolean;
  snapshot: (record: TRecord) => TSnapshot;
  capacityError: string;
  disposedError: string;
  /** Stop one active record and resolve once it has settled. */
  teardown: (record: TRecord) => Promise<unknown>;
  onSettled?: (snapshot: TSnapshot) => void;
  onChange?: () => void;
}

/**
 * Shared lifecycle for background job managers.
 *
 * It owns the parts that are the same whatever the job is — id minting,
 * capacity, lookup, settlement notification, retention of finished records,
 * observer-aware waiting, and shutdown — and leaves each manager to decide what
 * starting, settling, and stopping actually mean.
 */
export class AsyncJobRegistry<
  TState,
  TRecord extends JobRecord<TState>,
  TSnapshot,
> {
  private readonly records = new Map<string, TRecord>();
  private readonly options: AsyncJobRegistryOptions<TState, TRecord, TSnapshot>;
  private counter = 0;
  private shuttingDown = false;

  constructor(options: AsyncJobRegistryOptions<TState, TRecord, TSnapshot>) {
    this.options = options;
  }

  get disposed(): boolean {
    return this.shuttingDown;
  }

  get activeCount(): number {
    let count = 0;
    for (const record of this.records.values())
      if (this.options.isActive(record.state)) count++;
    return count;
  }

  /** Reject a start that the registry cannot accept, before any work begins. */
  assertAccepting(additional = 1): void {
    if (this.shuttingDown) throw new Error(this.options.disposedError);
    if (this.activeCount + additional > this.options.maxActive)
      throw new Error(this.options.capacityError);
  }

  /** Mint the fields every record shares; the caller fills in the rest. */
  newRecord(state: TState): JobRecord<TState> {
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    return {
      id: `${this.options.idPrefix}-${++this.counter}`,
      createdAt: Date.now(),
      settled,
      resolveSettled,
      state,
      observers: 0,
    };
  }

  add(record: TRecord): void {
    this.records.set(record.id, record);
  }

  changed(): void {
    this.options.onChange?.();
  }

  snapshotOf(record: TRecord): TSnapshot {
    return this.options.snapshot(record);
  }

  get(id: string): TSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.snapshotOf(record) : undefined;
  }

  list(): TSnapshot[] {
    return [...this.records.values()].map((record) => this.snapshotOf(record));
  }

  require(id: string): TRecord {
    const record = this.records.get(id);
    if (record) return record;
    const known = [...this.records.keys()].join(', ') || 'none';
    throw new Error(`Unknown ${this.options.label} "${id}". Known: ${known}.`);
  }

  active(): TRecord[] {
    return [...this.records.values()].filter((record) =>
      this.options.isActive(record.state),
    );
  }

  /**
   * Run work while the given records are marked as watched.
   *
   * A watched record settles quietly: whoever is waiting will see the outcome
   * themselves, so pushing a settlement notification at them too would report
   * it twice.
   */
  async observing<T>(
    records: readonly TRecord[],
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    for (const record of records) record.observers++;
    try {
      const result = work();
      return await (signal ? withAbort(result, signal) : result);
    } finally {
      for (const record of records) record.observers--;
    }
  }

  async peek(id: string, waitMs = 0, signal?: AbortSignal): Promise<TSnapshot> {
    const record = this.require(id);
    if (!this.options.isActive(record.state) || waitMs <= 0)
      return this.snapshotOf(record);
    return this.observing([record], async () => {
      await waitFor(record.settled, waitMs, signal);
      return this.snapshotOf(record);
    });
  }

  /** Record a final state and tell everyone who cares. Idempotent. */
  settle(record: TRecord, state: TState): TSnapshot {
    if (!this.options.isActive(record.state)) return this.snapshotOf(record);
    record.state = state;
    record.settledAt = Date.now();
    record.resolveSettled();
    const snapshot = this.snapshotOf(record);
    if (!this.shuttingDown && record.observers === 0)
      this.options.onSettled?.(snapshot);
    this.prune();
    this.changed();
    return snapshot;
  }

  async dispose(): Promise<TRecord[]> {
    if (this.shuttingDown) return [];
    this.shuttingDown = true;
    const active = this.active();
    await Promise.all(active.map((record) => this.options.teardown(record)));
    this.records.clear();
    this.changed();
    return active;
  }

  /** Keep only the most recently settled records; active ones always stay. */
  private prune(): void {
    const settled = [...this.records.values()]
      .filter((record) => !this.options.isActive(record.state))
      .sort(
        (left, right) =>
          (left.settledAt ?? left.createdAt) -
          (right.settledAt ?? right.createdAt),
      );
    for (const record of settled.slice(0, -this.options.maxSettled))
      this.records.delete(record.id);
  }
}
