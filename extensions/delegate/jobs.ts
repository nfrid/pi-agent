import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AsyncJobRegistry, type JobRecord } from '../shared/runtime/registry';
import { copyDelegateLifecycle, getDelegateLifecycle } from './lifecycle';
import { buildParentHandoff } from './output';
import { serializeDelegateRunForPublic } from './structured-result';
import type { DelegateDetails, DelegatedRun } from './types';
import { getRunState, isRunError } from './types';
import { failedLifecycleRun } from './worktree-lifecycle';

export const MAX_DELEGATE_JOBS = 20;
export const MAX_SETTLED_DELEGATE_JOBS = 32;

export type DelegateJobState =
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'aborted';

export interface DelegateJobResult {
  /** Runs safe to expose in the retained job snapshot. */
  runs: DelegatedRun[];
  handoff: string;
  /** Original runs retained for a later owner-session materialization retry. */
  retainedRuns?: DelegatedRun[];
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
  ownerSessionId?: string;
  runs?: DelegatedRun[];
  /** A branch-safe view; the retained runs stay private for retry. */
  snapshotRuns?: DelegatedRun[];
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
  /** Session whose branch owns artifact publication and exact handoff text. */
  ownerSessionId?: string;
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
        ownerSessionId: item.ownerSessionId,
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

  get(id: string, ctx?: ExtensionContext): DelegateJobSnapshot | undefined {
    const job = this.registry.get(id);
    return job ? this.visibleSnapshot(job, ctx) : undefined;
  }

  list(ctx?: ExtensionContext): DelegateJobSnapshot[] {
    return this.registry.list().map((job) => this.visibleSnapshot(job, ctx));
  }

  async peek(
    id: string,
    waitMs = 0,
    signal?: AbortSignal,
    ctx?: ExtensionContext,
  ): Promise<DelegateJobSnapshot> {
    return this.visibleSnapshot(
      await this.registry.peek(id, waitMs, signal),
      ctx,
    );
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
      return this.visibleSnapshot(snapshot(record), ctx);

    if (!record.materializing) {
      const work = (async () => {
        const result = await record.materialize?.(ctx, record.runs ?? []);
        if (!result) return;
        record.runs = result.retainedRuns ?? result.runs;
        record.snapshotRuns =
          result.retainedRuns && result.retainedRuns !== result.runs
            ? result.runs
            : undefined;
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
    return this.visibleSnapshot(snapshot(record), ctx);
  }

  async cancel(
    ids: readonly string[],
    signal?: AbortSignal,
    ctx?: ExtensionContext,
  ): Promise<DelegateJobSnapshot[]> {
    const records = [...new Set(ids)].map((id) => this.registry.require(id));
    return this.registry.observing(
      records,
      async () => {
        for (const record of records)
          record.controller.abort(new Error('Delegate job was cancelled.'));
        await Promise.all(records.map((record) => record.settled));
        return records.map((record) =>
          this.visibleSnapshot(snapshot(record), ctx),
        );
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

  private visibleSnapshot(
    job: DelegateJobSnapshot,
    ctx?: ExtensionContext,
  ): DelegateJobSnapshot {
    const ownerSessionId = this.registryOwnerSessionId(job.id);
    if (
      !ctx ||
      !ownerSessionId ||
      ctx.sessionManager.getSessionId() === ownerSessionId
    )
      return job;
    const runs = job.runs?.map((run) => {
      const { artifact: _artifact, ...safeRun } = serializeDelegateRunForPublic(
        run,
        { includeArtifacts: false },
      );
      // This is the only projection where the owner artifact handle and
      // handoff are intentionally hidden. Keep one bounded harness capture so
      // a stale-session peek remains actionable without exposing stderr.
      const lifecycle = getDelegateLifecycle(run, {
        includeArtifact: false,
        forceInlineDiagnostic: true,
      });
      if (lifecycle) safeRun.lifecycle = lifecycle;
      return safeRun;
    });
    const { handoff: _handoff, ...safeJob } = job;
    return { ...safeJob, runs };
  }

  private registryOwnerSessionId(id: string): string | undefined {
    return this.registry.require(id).ownerSessionId;
  }

  private async run(record: DelegateJobRecord): Promise<void> {
    record.state = 'running';
    record.startedAt = Date.now();
    this.registry.changed();
    let state: DelegateJobState;
    try {
      const result = await record.execute(record.controller.signal);
      record.runs = result.retainedRuns ?? result.runs;
      record.snapshotRuns =
        result.retainedRuns && result.retainedRuns !== result.runs
          ? result.runs
          : undefined;
      record.handoff = result.handoff;
      state = aggregateState(result.runs, record.controller.signal.aborted);
    } catch (error) {
      state = record.controller.signal.aborted ? 'aborted' : 'error';
      const runs = (record.tasks.length > 0 ? record.tasks : [record.name]).map(
        (task) =>
          failedLifecycleRun(
            task,
            undefined,
            {
              name: record.name,
              backgroundJobId: record.id,
              warnings: [],
            },
            error,
            record.controller.signal.aborted
              ? 'user-cancellation'
              : error instanceof Error
                ? 'provider-runner-error'
                : 'unknown',
          ),
      );
      record.runs = runs;
      record.handoff = buildParentHandoff(runs);
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
    runs: (record.snapshotRuns ?? record.runs)?.map((run) => {
      const projected = serializeDelegateRunForPublic(run);
      // JSON-like job snapshots clone the enumerable run, so retain the
      // harness record for another trusted snapshot/owner-session projection.
      const clone = { ...projected };
      copyDelegateLifecycle(projected, clone);
      return clone;
    }),
    handoff: record.handoff,
    error: record.error,
    deliveryEpoch: record.deliveryEpoch,
    route: record.route,
    allowWrites: record.allowWrites,
  };
}
