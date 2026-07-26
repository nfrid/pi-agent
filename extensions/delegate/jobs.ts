import { waitFor, withAbort } from '../shared/runtime/async';
import type { DelegateDetails, DelegatedRun } from './types';
import { getRunState, isRunError } from './types';

export const MAX_DELEGATE_JOBS = 20;
export const MAX_SETTLED_DELEGATE_JOBS = 32;

export type DelegateJobState =
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'aborted';

export interface DelegateJobResult {
  runs: DelegatedRun[];
  handoff: string;
}

export interface DelegateJobSnapshot {
  id: string;
  name: string;
  mode: DelegateDetails['mode'];
  state: DelegateJobState;
  tasks: string[];
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
  runs?: DelegatedRun[];
  handoff?: string;
  error?: string;
  deliveryEpoch?: number;
  route?: string;
  allowWrites?: boolean;
}

interface DelegateJobRecord {
  id: string;
  name: string;
  mode: DelegateDetails['mode'];
  state: DelegateJobState;
  tasks: string[];
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
  runs?: DelegatedRun[];
  handoff?: string;
  error?: string;
  deliveryEpoch?: number;
  route?: string;
  allowWrites?: boolean;
  controller: AbortController;
  execute: (signal: AbortSignal) => Promise<DelegateJobResult>;
  settled: Promise<void>;
  resolveSettled: () => void;
  observers: number;
}

export interface DelegateJobManagerOptions {
  onSettled?: (snapshot: DelegateJobSnapshot) => void;
  onChange?: () => void;
}

export interface DelegateJobStartOptions {
  name?: string;
  mode: DelegateDetails['mode'];
  tasks: string[];
  execute: (signal: AbortSignal) => Promise<DelegateJobResult>;
  deliveryEpoch?: number;
  route?: string;
  allowWrites?: boolean;
}

function aggregateState(
  runs: DelegatedRun[],
  aborted: boolean,
): DelegateJobState {
  if (
    aborted ||
    (runs.length > 0 && runs.every((run) => getRunState(run) === 'aborted'))
  )
    return 'aborted';
  return runs.some(isRunError) ? 'error' : 'success';
}

export class DelegateJobManager {
  private readonly records = new Map<string, DelegateJobRecord>();
  private readonly onSettled?: (snapshot: DelegateJobSnapshot) => void;
  private readonly onChange?: () => void;
  private counter = 0;
  private disposed = false;

  constructor(options: DelegateJobManagerOptions = {}) {
    this.onSettled = options.onSettled;
    this.onChange = options.onChange;
  }

  start(options: DelegateJobStartOptions): DelegateJobSnapshot {
    const [job] = this.startMany([options]);
    return job;
  }

  startMany(options: DelegateJobStartOptions[]): DelegateJobSnapshot[] {
    if (this.disposed)
      throw new Error('Delegate job manager is shutting down.');
    if (this.runningCount + options.length > MAX_DELEGATE_JOBS)
      throw new Error(
        `At most ${MAX_DELEGATE_JOBS} background delegate jobs may run at once.`,
      );

    const records = options.map((item): DelegateJobRecord => {
      let resolveSettled = () => {};
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      return {
        id: `dj-${++this.counter}`,
        name: item.name?.trim() || 'Subagent',
        mode: item.mode,
        state: 'queued',
        tasks: [...item.tasks],
        createdAt: Date.now(),
        deliveryEpoch: item.deliveryEpoch,
        route: item.route,
        allowWrites: item.allowWrites,
        controller: new AbortController(),
        execute: item.execute,
        settled,
        resolveSettled,
        observers: 0,
      };
    });
    for (const record of records) this.records.set(record.id, record);
    this.onChange?.();
    for (const record of records) void this.run(record);
    return records.map((record) => this.snapshot(record));
  }

  get(id: string): DelegateJobSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.snapshot(record) : undefined;
  }

  list(): DelegateJobSnapshot[] {
    return [...this.records.values()].map((record) => this.snapshot(record));
  }

  async peek(
    id: string,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<DelegateJobSnapshot> {
    const record = this.require(id);
    if (
      (record.state === 'queued' || record.state === 'running') &&
      waitMs > 0
    ) {
      record.observers++;
      try {
        await waitFor(record.settled, waitMs, signal);
        return this.snapshot(record);
      } finally {
        record.observers--;
      }
    }
    return this.snapshot(record);
  }

  async cancel(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<DelegateJobSnapshot[]> {
    const records = [...new Set(ids)].map((id) => this.require(id));
    for (const record of records) record.observers++;
    try {
      for (const record of records) {
        if (record.state === 'queued' || record.state === 'running')
          record.controller.abort(new Error('Delegate job was cancelled.'));
      }
      const completion = Promise.all(records.map((record) => record.settled));
      if (signal) await withAbort(completion, signal);
      else await completion;
      return records.map((record) => this.snapshot(record));
    } finally {
      for (const record of records) record.observers--;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const active = [...this.records.values()].filter(
      (record) => record.state === 'queued' || record.state === 'running',
    );
    for (const record of active)
      record.controller.abort(new Error('Delegate session is shutting down.'));
    await Promise.all(active.map((record) => record.settled));
    this.records.clear();
    this.onChange?.();
  }

  get runningCount(): number {
    let count = 0;
    for (const record of this.records.values())
      if (record.state === 'queued' || record.state === 'running') count++;
    return count;
  }

  private require(id: string): DelegateJobRecord {
    const record = this.records.get(id);
    if (record) return record;
    const known = [...this.records.keys()].join(', ') || 'none';
    throw new Error(`Unknown delegate job "${id}". Known: ${known}.`);
  }

  private async run(record: DelegateJobRecord): Promise<void> {
    record.state = 'running';
    record.startedAt = Date.now();
    this.onChange?.();
    try {
      const result = await record.execute(record.controller.signal);
      record.runs = result.runs;
      record.handoff = result.handoff;
      record.state = aggregateState(
        result.runs,
        record.controller.signal.aborted,
      );
    } catch (error) {
      record.state = record.controller.signal.aborted ? 'aborted' : 'error';
      record.error = error instanceof Error ? error.message : String(error);
    } finally {
      record.settledAt = Date.now();
      record.resolveSettled();
      const snapshot = this.snapshot(record);
      if (!this.disposed && record.observers === 0) this.onSettled?.(snapshot);
      this.prune();
      this.onChange?.();
    }
  }

  private prune(): void {
    const settled = [...this.records.values()]
      .filter(
        (record) => record.state !== 'queued' && record.state !== 'running',
      )
      .sort(
        (left, right) =>
          (left.settledAt ?? left.createdAt) -
          (right.settledAt ?? right.createdAt),
      );
    for (const record of settled.slice(0, -MAX_SETTLED_DELEGATE_JOBS))
      this.records.delete(record.id);
  }

  private snapshot(record: DelegateJobRecord): DelegateJobSnapshot {
    return {
      id: record.id,
      name: record.name,
      mode: record.mode,
      state: record.state,
      tasks: [...record.tasks],
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      settledAt: record.settledAt,
      runs: record.runs ? [...record.runs] : undefined,
      handoff: record.handoff,
      error: record.error,
      deliveryEpoch: record.deliveryEpoch,
      route: record.route,
      allowWrites: record.allowWrites,
    };
  }
}
