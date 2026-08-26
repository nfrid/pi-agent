import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AsyncJobRegistry, type JobRecord } from '../shared/runtime/registry';
import type {
  PendingProcessAccounting,
  SessionScopeId,
} from '../shared/runtime/scoped-services';
import { copyDelegateLifecycle } from './lifecycle';
import { buildParentHandoff } from './output';
import { serializeDelegateRunForPublic } from './serialize';
import type {
  DelegateChildCapability,
  DelegateDetails,
  DelegatedRun,
} from './types';
import { getRunState, isRunError } from './types';
import {
  normalizeWorkflowAttempt,
  type WorkflowAttempt,
} from './workflow-model';
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

export type DelegateJobFeedbackDelivery = 'queued' | 'settled' | 'unavailable';

export interface DelegateJobFeedbackResult {
  job: DelegateJobSnapshot;
  delivery: DelegateJobFeedbackDelivery;
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
  capabilities?: DelegateChildCapability[];
  /** Optional workflow identity projected from the session-scoped model. */
  logicalId?: string;
  attemptIdentity?: string;
}

interface DelegateJobRecord extends JobRecord<DelegateJobState> {
  name: string;
  mode: DelegateDetails['mode'];
  tasks: string[];
  startedAt?: number;
  runs?: DelegatedRun[];
  /** A branch-safe view; the retained runs stay private for retry. */
  snapshotRuns?: DelegatedRun[];
  /** Immutable branch owning workflow metadata. */
  ownerBranchId?: string;
  handoff?: string;
  error?: string;
  deliveryEpoch?: number;
  route?: string;
  allowWrites?: boolean;
  capabilities?: DelegateChildCapability[];
  workflowAttempt?: WorkflowAttempt;
  feedback?: (
    message: string,
  ) => import('./control').DelegateControlEnqueueResult;
  controller: AbortController;
  detachController: AbortController;
  detached: boolean;
  detachOnTeardown: boolean;
  execute: (
    signal: AbortSignal,
    detachSignal?: AbortSignal,
  ) => Promise<DelegateJobResult>;
  materialize?: DelegateJobMaterializer;
  onTerminal?: (
    result: DelegateJobResult,
    snapshot: DelegateJobSnapshot,
  ) => void;
  materializing?: Promise<void>;
}

export interface DelegateJobManagerOptions {
  scopeId?: SessionScopeId;
  pendingProcesses?: PendingProcessAccounting;
  onSettled?: (snapshot: DelegateJobSnapshot) => void;
  onChange?: () => void;
}

export interface DelegateJobStartOptions {
  name?: string;
  /** Immutable branch whose path owns workflow metadata. */
  ownerBranchId?: string;
  mode: DelegateDetails['mode'];
  tasks: string[];
  execute: (
    signal: AbortSignal,
    detachSignal?: AbortSignal,
  ) => Promise<DelegateJobResult>;
  /** Hosted process jobs survive parent teardown; cancellation still stops them. */
  detachOnTeardown?: boolean;
  materialize?: DelegateJobMaterializer;
  /** Unconditional terminal notification, including settlement observed by peek. */
  onTerminal?: (
    result: DelegateJobResult,
    snapshot: DelegateJobSnapshot,
  ) => void;
  deliveryEpoch?: number;
  route?: string;
  allowWrites?: boolean;
  capabilities?: DelegateChildCapability[];
  /** Canonical Pi child session linked to a hosted process job. */
  sessionId?: string;
  /** Durable process-host job identity; equals the prepared run ID. */
  processJobId?: string;
  workflowAttempt?: WorkflowAttempt;
  feedback?: (
    message: string,
  ) => import('./control').DelegateControlEnqueueResult;
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
        if (record.detachOnTeardown) {
          record.detached = true;
          record.detachController.abort(
            new Error('Delegate session detached from its hosted job.'),
          );
        } else {
          record.controller.abort(
            new Error('Delegate session is shutting down.'),
          );
        }
        await record.settled;
      },
      scopeId: options.scopeId,
      pendingProcesses: options.pendingProcesses,
      onSettled: options.onSettled,
      onChange: options.onChange,
    });
  }

  start(options: DelegateJobStartOptions): DelegateJobSnapshot {
    const [job] = this.startMany([options]);
    return job;
  }

  /**
   * Register an observation of work that already exists in the durable host.
   * The manager still owns an ordinary in-memory record, but the supplied
   * execute function is responsible for observing it; this method never
   * creates a host process itself.
   */
  observeExisting(options: DelegateJobStartOptions): DelegateJobSnapshot {
    const [job] = this.startMany([options]);
    return job;
  }

  startMany(options: DelegateJobStartOptions[]): DelegateJobSnapshot[] {
    this.registry.assertAccepting(options.length);
    const validated = options.map((item) => ({
      item,
      workflowAttempt:
        item.workflowAttempt === undefined
          ? undefined
          : normalizeWorkflowAttempt(item.workflowAttempt),
    }));
    const records = validated.map(
      ({ item, workflowAttempt }): DelegateJobRecord => ({
        ...this.registry.newRecord('queued'),
        name: item.name?.trim() || 'Subagent',
        ownerBranchId: item.ownerBranchId,
        mode: item.mode,
        tasks: [...item.tasks],
        deliveryEpoch: item.deliveryEpoch,
        route: item.route,
        allowWrites: item.allowWrites,
        capabilities: item.capabilities ? [...item.capabilities] : undefined,
        workflowAttempt,
        feedback: item.feedback,
        controller: new AbortController(),
        detachController: new AbortController(),
        detached: false,
        detachOnTeardown: item.detachOnTeardown === true,
        execute: item.execute,
        materialize: item.materialize,
        onTerminal: item.onTerminal,
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

  /** Internal branch guard for exact workflow observation binding. */
  getOwnerBranchId(id: string): string | undefined {
    return this.registry.require(id).ownerBranchId;
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

  sendFeedback(
    id: string,
    message: string,
    ctx?: ExtensionContext,
  ): DelegateJobFeedbackResult {
    const record = this.registry.require(id);
    if (!this.registryActive(record))
      return {
        job: this.visibleSnapshot(snapshot(record), ctx),
        delivery: 'settled',
      };
    if (!record.feedback)
      return {
        job: this.visibleSnapshot(snapshot(record), ctx),
        delivery: 'unavailable',
      };
    const queued = record.feedback(message);
    return {
      job: this.visibleSnapshot(snapshot(record), ctx),
      delivery: queued.accepted ? 'queued' : 'unavailable',
    };
  }

  async detach(
    ids: readonly string[],
    signal?: AbortSignal,
    ctx?: ExtensionContext,
  ): Promise<DelegateJobSnapshot[]> {
    const records = [...new Set(ids)].map((id) => this.registry.require(id));
    return this.registry.observing(
      records,
      async () => {
        for (const record of records) {
          if (!this.registryActive(record)) continue;
          if (record.detachOnTeardown) {
            record.detached = true;
            record.detachController.abort(
              new Error('Delegate job detached from its parent session.'),
            );
          } else {
            // Legacy/in-process records retain their original teardown
            // cancellation semantics; only hosted records detach.
            record.controller.abort(
              new Error('Delegate job was cancelled during teardown.'),
            );
          }
        }
        await Promise.all(records.map((record) => record.settled));
        return records.map((record) =>
          this.visibleSnapshot(snapshot(record), ctx),
        );
      },
      signal,
    );
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

  /** Preflight capacity and disposal checks before a coordinator commits identity. */
  assertAccepting(additional = 1): void {
    this.registry.assertAccepting(additional);
  }

  get runningCount(): number {
    return this.registry.activeCount;
  }

  private registryActive(record: DelegateJobRecord): boolean {
    return record.state === 'queued' || record.state === 'running';
  }

  private visibleSnapshot(
    job: DelegateJobSnapshot,
    _ctx?: ExtensionContext,
  ): DelegateJobSnapshot {
    return job;
  }

  private async run(record: DelegateJobRecord): Promise<void> {
    record.state = 'running';
    record.startedAt = Date.now();
    this.registry.changed();
    let state: DelegateJobState;
    let result: DelegateJobResult;
    try {
      result = await record.execute(
        record.controller.signal,
        record.detachController.signal,
      );
      record.runs = result.retainedRuns ?? result.runs;
      record.snapshotRuns =
        result.retainedRuns && result.retainedRuns !== result.runs
          ? result.runs
          : undefined;
      record.handoff = result.handoff;
      state = aggregateState(result.runs, record.controller.signal.aborted);
    } catch (error) {
      if (record.detached) {
        result = { runs: [], handoff: '' };
        state = 'aborted';
        this.registry.settle(record, state);
        return;
      }
      state = record.controller.signal.aborted ? 'aborted' : 'error';
      const runs = (record.tasks.length > 0 ? record.tasks : [record.name]).map(
        (task) =>
          failedLifecycleRun(
            task,
            undefined,
            {
              name: record.name,
              backgroundJobId: record.id,
              workflowAttempt: record.workflowAttempt,
              capabilities: record.capabilities ? [...record.capabilities] : [],
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
      result = { runs, handoff: record.handoff };
    }
    const settled = this.registry.settle(record, state);
    // Unlike registry.onSettled, this is per-job and deliberately ignores
    // observer count so a waiting peek cannot suppress workflow readiness.
    if (!record.detached) record.onTerminal?.(result, settled);
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
    runs: (() => {
      const projectedRuns = (record.snapshotRuns ?? record.runs)?.map((run) =>
        serializeDelegateRunForPublic(run),
      );
      if (!projectedRuns) return undefined;
      return projectedRuns.map((projected) => {
        // JSON-like job snapshots clone the enumerable run, so retain the
        // harness record for another trusted snapshot/owner-session projection.
        const clone = { ...projected };
        copyDelegateLifecycle(projected, clone);
        return clone;
      });
    })(),
    handoff: record.handoff,
    error: record.error,
    deliveryEpoch: record.deliveryEpoch,
    route: record.route,
    allowWrites: record.allowWrites,
    capabilities: record.capabilities ? [...record.capabilities] : undefined,
    ...(record.workflowAttempt
      ? {
          logicalId: record.workflowAttempt.logicalId,
          attemptIdentity: record.workflowAttempt.identity,
        }
      : {}),
  };
}
