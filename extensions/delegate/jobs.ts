import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AsyncJobRegistry, type JobRecord } from '../shared/runtime/registry';
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

export type DelegateJobMaterializer = (
  ctx: ExtensionContext,
  runs: DelegatedRun[],
) => Promise<DelegateJobResult>;

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

interface DelegateJobRecord extends JobRecord<DelegateJobState> {
  name: string;
  mode: DelegateDetails['mode'];
  tasks: string[];
  startedAt?: number;
  runs?: DelegatedRun[];
  handoff?: string;
  error?: string;
  deliveryEpoch?: number;
  route?: string;
  allowWrites?: boolean;
  controller: AbortController;
  execute: (signal: AbortSignal) => Promise<DelegateJobResult>;
  materialize?: DelegateJobMaterializer;
  materializing?: Promise<void>;
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
  materialize?: DelegateJobMaterializer;
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

/** Background delegate runs: started as promises, cancelled by aborting them. */
export class DelegateJobManager {
  private readonly registry: AsyncJobRegistry<
    DelegateJobState,
    DelegateJobRecord,
    DelegateJobSnapshot
  >;

  constructor(options: DelegateJobManagerOptions = {}) {
    this.registry = new AsyncJobRegistry({
      idPrefix: 'dj',
      label: 'delegate job',
      maxActive: MAX_DELEGATE_JOBS,
      maxSettled: MAX_SETTLED_DELEGATE_JOBS,
      isActive: (state) => state === 'queued' || state === 'running',
      snapshot: (record) => snapshot(record),
      capacityError: `At most ${MAX_DELEGATE_JOBS} background delegate jobs may run at once.`,
      disposedError: 'Delegate job manager is shutting down.',
      teardown: async (record) => {
        record.controller.abort(
          new Error('Delegate session is shutting down.'),
        );
        await record.settled;
      },
      onSettled: options.onSettled,
      onChange: options.onChange,
    });
  }

  start(options: DelegateJobStartOptions): DelegateJobSnapshot {
    const [job] = this.startMany([options]);
    return job;
  }

  startMany(options: DelegateJobStartOptions[]): DelegateJobSnapshot[] {
    this.registry.assertAccepting(options.length);
    const records = options.map(
      (item): DelegateJobRecord => ({
        ...this.registry.newRecord('queued'),
        name: item.name?.trim() || 'Subagent',
        mode: item.mode,
        tasks: [...item.tasks],
        deliveryEpoch: item.deliveryEpoch,
        route: item.route,
        allowWrites: item.allowWrites,
        controller: new AbortController(),
        execute: item.execute,
        materialize: item.materialize,
      }),
    );
    for (const record of records) this.registry.add(record);
    this.registry.changed();
    for (const record of records) void this.run(record);
    return records.map((record) => snapshot(record));
  }

  get(id: string): DelegateJobSnapshot | undefined {
    return this.registry.get(id);
  }

  list(): DelegateJobSnapshot[] {
    return this.registry.list();
  }

  peek(
    id: string,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<DelegateJobSnapshot> {
    return this.registry.peek(id, waitMs, signal);
  }

  async materialize(
    id: string,
    ctx: ExtensionContext,
  ): Promise<DelegateJobSnapshot> {
    const record = this.registry.require(id);
    if (
      !record.materialize ||
      !record.runs ||
      record.state === 'queued' ||
      record.state === 'running'
    )
      return snapshot(record);

    if (!record.materializing) {
      const work = (async () => {
        const result = await record.materialize?.(ctx, record.runs ?? []);
        if (!result) return;
        record.runs = result.runs;
        record.handoff = result.handoff;
        this.registry.changed();
      })();
      record.materializing = work;
      try {
        await work;
      } finally {
        if (record.materializing === work) record.materializing = undefined;
      }
    } else await record.materializing;
    return snapshot(record);
  }

  async cancel(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<DelegateJobSnapshot[]> {
    const records = [...new Set(ids)].map((id) => this.registry.require(id));
    return this.registry.observing(
      records,
      async () => {
        for (const record of records)
          record.controller.abort(new Error('Delegate job was cancelled.'));
        await Promise.all(records.map((record) => record.settled));
        return records.map((record) => snapshot(record));
      },
      signal,
    );
  }

  async dispose(): Promise<void> {
    await this.registry.dispose();
  }

  get runningCount(): number {
    return this.registry.activeCount;
  }

  private async run(record: DelegateJobRecord): Promise<void> {
    record.state = 'running';
    record.startedAt = Date.now();
    this.registry.changed();
    let state: DelegateJobState;
    try {
      const result = await record.execute(record.controller.signal);
      record.runs = result.runs;
      record.handoff = result.handoff;
      state = aggregateState(result.runs, record.controller.signal.aborted);
    } catch (error) {
      state = record.controller.signal.aborted ? 'aborted' : 'error';
      record.error = error instanceof Error ? error.message : String(error);
    }
    this.registry.settle(record, state);
  }
}

function snapshot(record: DelegateJobRecord): DelegateJobSnapshot {
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
