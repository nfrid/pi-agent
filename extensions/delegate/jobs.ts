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

export interface DelegateJobSnapshot {
  id: string;
  /** Jobs started by one startMany call share this cohort. */
  cohortId: string;
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
  cohortId: string;
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
}

export interface DelegateJobManagerOptions {
  onSettled?: (snapshots: DelegateJobSnapshot[]) => void;
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

/** Background delegate runs: started as promises, cancelled by aborting them. */
export class DelegateJobManager {
  private readonly cohorts = new Map<
    string,
    { ids: string[]; pending: Map<string, DelegateJobSnapshot> }
  >();
  private cohortCounter = 0;
  private readonly onSettled: DelegateJobManagerOptions['onSettled'];
  private readonly registry: AsyncJobRegistry<
    DelegateJobState,
    DelegateJobRecord,
    DelegateJobSnapshot
  >;

  constructor(options: DelegateJobManagerOptions = {}) {
    this.onSettled = options.onSettled;
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
      onSettled: (snapshot) => this.handleSettled(snapshot),
      onObserversChanged: () => this.flushCohorts(),
      onChange: options.onChange,
    });
  }

  start(options: DelegateJobStartOptions): DelegateJobSnapshot {
    const [job] = this.startMany([options]);
    return job;
  }

  startMany(options: DelegateJobStartOptions[]): DelegateJobSnapshot[] {
    this.registry.assertAccepting(options.length);
    if (options.length === 0) return [];
    const cohortId = `dc-${++this.cohortCounter}`;
    const records = options.map(
      (item): DelegateJobRecord => ({
        ...this.registry.newRecord('queued'),
        cohortId,
        name: item.name?.trim() || 'Subagent',
        mode: item.mode,
        tasks: [...item.tasks],
        deliveryEpoch: item.deliveryEpoch,
        route: item.route,
        allowWrites: item.allowWrites,
        controller: new AbortController(),
        execute: item.execute,
      }),
    );
    this.cohorts.set(cohortId, {
      ids: records.map((record) => record.id),
      pending: new Map(),
    });
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
    this.cohorts.clear();
  }

  get runningCount(): number {
    return this.registry.activeCount;
  }

  private handleSettled(snapshot: DelegateJobSnapshot): void {
    const cohort = this.cohorts.get(snapshot.cohortId);
    if (!cohort) return;
    cohort.pending.set(snapshot.id, snapshot);
    this.flushCohort(snapshot.cohortId);
  }

  private flushCohorts(): void {
    for (const cohortId of this.cohorts.keys()) this.flushCohort(cohortId);
  }

  private flushCohort(cohortId: string): void {
    const cohort = this.cohorts.get(cohortId);
    if (!cohort) return;
    const active = new Set(
      this.registry
        .list()
        .filter((job) => job.cohortId === cohortId)
        .filter((job) => job.state === 'queued' || job.state === 'running')
        .map((job) => job.id),
    );
    if (active.size > 0) return;
    const settled = cohort.ids
      .map((id) => cohort.pending.get(id))
      .filter((job): job is DelegateJobSnapshot => job !== undefined);
    this.cohorts.delete(cohortId);
    if (settled.length > 0) this.onSettled?.(settled);
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
    cohortId: record.cohortId,
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
