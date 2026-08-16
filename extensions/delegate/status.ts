import type { DelegateResult } from './contribution';
import { cloneDelegateLifecycle } from './lifecycle';
import {
  getDelegateResultSpec,
  serializeDelegateRunForPublic,
} from './structured-result';
import type {
  DelegateContext,
  DelegatedActivity,
  DelegatedRun,
  DelegateLifecycleProjection,
  DelegateRunState,
} from './types';
import { getRunState } from './types';
import type { WakeSnapshot } from './wake-coordinator';
import type { DelegateWorkflowAttemptSnapshot } from './workflow-coordinator';
import type { WorkflowAttemptState } from './workflow-model';

export type DelegateStatusKind = 'foreground' | 'background';
export type DelegatePauseState = 'pausing' | 'paused';

export interface DelegateStatusTiming {
  state: DelegateRunState;
  startedAt?: number;
  finishedAt?: number;
}

export interface DelegateTranscriptEntry {
  id: string;
  type: 'task' | 'thinking' | 'tool' | 'assistant' | 'error';
  label: string;
  /** Canonical tool name; label remains a compact activity description. */
  name?: string;
  arguments?: unknown;
  result?: unknown;
  argumentsTruncated?: boolean;
  resultTruncated?: boolean;
  text?: string;
  status?: 'running' | 'completed' | 'error';
  at?: number;
  run?: number;
}

export interface DelegateWorkflowStatus {
  logicalId: string;
  attempt: number;
  identity: string;
  state: WorkflowAttemptState;
  dependencies: string[];
  waitingFor?: string[];
  reason?: string;
  route?: string;
  createdAt: number;
  scheduledAt: number;
  queuedAt?: number;
  startedAt?: number;
  settledAt?: number;
  deliveredToParent?: boolean;
}

export interface DelegateWakeStatus {
  id: string;
  state: WakeSnapshot['state'];
  references: string[];
  waitingFor?: string[];
  createdAt: number;
  readyAt?: number;
  queuedAt?: number;
  enteredAt?: number;
  cancelledAt?: number;
  blockedAt?: number;
  reason?: string;
}

export interface DelegateStatusSnapshot {
  id: string;
  /** Stable invocation identity for the current aggregated run. */
  runId: string;
  /** Canonical Pi child session used by dashboard session APIs. */
  sessionId?: string;
  /** Stable child-session lineage identity shared by continuations. */
  lineageId: string;
  name: string;
  kind: DelegateStatusKind;
  state: DelegateRunState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  jobId?: string;
  route?: string;
  context?: DelegateContext;
  allowWrites: boolean;
  activity?: DelegatedActivity;
  /** Invocation count within one continuation lineage. */
  runCount?: number;
  /** Every invocation retained for aggregate elapsed-time rendering. */
  runs?: DelegateStatusTiming[];
  /** Ordered, bounded activity and response history across the lineage. */
  transcript?: DelegateTranscriptEntry[];
  transcriptTruncated?: boolean;
  result?: DelegateResult;
  /** Harness-authored terminal projection retained in status snapshots. */
  lifecycle?: DelegateLifecycleProjection;
  /** Compact workflow identity/lifecycle metadata; never a result payload. */
  workflow?: DelegateWorkflowStatus;
  pauseState?: DelegatePauseState;
  pausedAt?: number;
}

interface DelegateStatusRecord extends DelegateStatusSnapshot {
  /** The completion has been returned or delivered into the parent context. */
  resultEntered: boolean;
  /** The parent fully settled with this result and may clear it next run. */
  clearOnNextUserMessage: boolean;
}

const MAX_TRANSCRIPT_ENTRIES = 128;

function assistantText(run: DelegatedRun): DelegateTranscriptEntry[] {
  return run.messages.flatMap((message, index) => {
    if (message.role !== 'assistant') return [];
    const value = message.content
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .trim();
    return value
      ? [
          {
            id: `assistant-${message.timestamp}-${index}`,
            type: 'assistant' as const,
            label: 'Response',
            text: value,
            status: 'completed' as const,
            at: message.timestamp,
          },
        ]
      : [];
  });
}

function transcript(
  run: DelegatedRun,
  activities: readonly DelegatedActivity[] = run.activities,
): DelegateTranscriptEntry[] {
  const entries: DelegateTranscriptEntry[] = [
    {
      id: 'task',
      type: 'task',
      label: 'Task',
      text: run.task,
      status: 'completed',
      at: run.queuedAt,
    },
    ...activities.map((activity, index) => ({
      id: activity.id ?? `activity-${index}`,
      type: activity.type,
      label: activity.label,
      ...(activity.type === 'tool' && activity.toolName
        ? { name: activity.toolName }
        : {}),
      ...(activity.type === 'tool' && activity.toolArguments !== undefined
        ? { arguments: activity.toolArguments }
        : {}),
      ...(activity.type === 'tool' && activity.toolResult !== undefined
        ? { result: activity.toolResult }
        : {}),
      ...(activity.type === 'tool' && activity.toolArgumentsTruncated
        ? { argumentsTruncated: true }
        : {}),
      ...(activity.type === 'tool' && activity.toolResultTruncated
        ? { resultTruncated: true }
        : {}),
      ...(activity.transcriptText || activity.latestText
        ? { text: activity.transcriptText ?? activity.latestText }
        : {}),
      status: activity.status,
      at: activity.startedAt,
    })),
    ...assistantText(run),
  ];
  if (run.errorMessage?.trim())
    entries.push({
      id: 'error',
      type: 'error',
      label: 'Error',
      text: run.errorMessage.trim(),
      status: 'error',
      at: run.finishedAt,
    });
  return entries
    .map((entry, order) => ({ entry, order }))
    .sort(
      (left, right) =>
        (left.entry.at ?? Number.MAX_SAFE_INTEGER) -
          (right.entry.at ?? Number.MAX_SAFE_INTEGER) ||
        left.order - right.order,
    )
    .map(({ entry }) => entry);
}

function isSettled(state: DelegateRunState): boolean {
  return state !== 'queued' && state !== 'running';
}

function isWorkflowTerminal(state: WorkflowAttemptState): boolean {
  return (
    state === 'success' ||
    state === 'error' ||
    state === 'timed-out' ||
    state === 'aborted' ||
    state === 'cancelled' ||
    state === 'blocked'
  );
}

function resultProjection(run: DelegatedRun): DelegateResult | undefined {
  const captured = serializeDelegateRunForPublic(run).structuredResult;
  if (!getDelegateResultSpec(run) && !captured) return undefined;
  if (!isSettled(getRunState(run)))
    return { kind: 'structured', status: 'pending' };
  if (!captured)
    return {
      kind: 'structured',
      status: 'invalid',
      errors: ['/: structured result settlement is unavailable'],
    };
  return {
    kind: 'structured',
    status: captured.valid ? 'valid' : 'invalid',
    ...(captured.valid && captured.value !== undefined
      ? { value: captured.value }
      : {}),
    ...(captured.valid && captured.valueOmitted ? { valueOmitted: true } : {}),
    ...(captured.errors.length ? { errors: [...captured.errors] } : {}),
  };
}

function workflowStatusFromAttempt(
  attempt: DelegateWorkflowAttemptSnapshot,
  previous?: DelegateWorkflowStatus,
): DelegateWorkflowStatus {
  return {
    logicalId: attempt.logicalId,
    attempt: attempt.ordinal,
    identity: attempt.identity,
    state: attempt.state,
    dependencies: [...attempt.dependencies],
    ...(attempt.waitingFor?.length
      ? { waitingFor: [...attempt.waitingFor] }
      : {}),
    ...(attempt.reason ? { reason: attempt.reason } : {}),
    ...(attempt.route ? { route: attempt.route } : {}),
    createdAt: attempt.createdAt,
    scheduledAt: attempt.scheduledAt,
    ...(attempt.queuedAt === undefined ? {} : { queuedAt: attempt.queuedAt }),
    ...(attempt.startedAt === undefined
      ? {}
      : { startedAt: attempt.startedAt }),
    ...(attempt.settledAt === undefined
      ? {}
      : { settledAt: attempt.settledAt }),
    ...(previous?.route && !attempt.route ? { route: previous.route } : {}),
    ...(previous?.deliveredToParent ? { deliveredToParent: true } : {}),
  };
}

function workflowStatusFromRun(
  attempt: NonNullable<DelegatedRun['workflowAttempt']>,
  state: DelegateRunState,
  run: DelegatedRun,
  previous?: DelegateWorkflowStatus,
): DelegateWorkflowStatus {
  return {
    logicalId: attempt.logicalId,
    attempt: attempt.ordinal,
    identity: attempt.identity,
    state,
    dependencies: previous?.dependencies ?? [],
    ...(previous?.waitingFor ? { waitingFor: [...previous.waitingFor] } : {}),
    ...(previous?.reason ? { reason: previous.reason } : {}),
    ...(run.routing?.route || previous?.route
      ? { route: run.routing?.route ?? previous?.route }
      : {}),
    createdAt: previous?.createdAt ?? run.queuedAt ?? Date.now(),
    scheduledAt: previous?.scheduledAt ?? run.queuedAt ?? Date.now(),
    ...(run.queuedAt === undefined
      ? previous?.queuedAt === undefined
        ? {}
        : { queuedAt: previous.queuedAt }
      : { queuedAt: run.queuedAt }),
    ...(run.startedAt === undefined
      ? previous?.startedAt === undefined
        ? {}
        : { startedAt: previous.startedAt }
      : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined
      ? previous?.settledAt === undefined
        ? {}
        : { settledAt: previous.settledAt }
      : { settledAt: run.finishedAt }),
    ...(previous?.deliveredToParent ? { deliveredToParent: true } : {}),
  };
}

function hasContent(activity: DelegatedActivity): boolean {
  return activity.type === 'thinking'
    ? Boolean(activity.latestText?.trim())
    : Boolean(activity.label.trim());
}

/**
 * A thinking block is announced before its first token arrives, and a tool call
 * before its label is known, so the newest activity is routinely blank for a
 * beat. Showing the last activity that had something to say keeps the row from
 * blinking empty between steps.
 */
function displayActivity(
  run: DelegatedRun,
  previous: DelegatedActivity | undefined,
): DelegatedActivity | undefined {
  for (let index = run.activities.length - 1; index >= 0; index--) {
    const activity = run.activities[index];
    if (hasContent(activity)) return activity;
  }
  return previous ?? run.activities.at(-1);
}

export class DelegateStatusStore {
  private readonly records = new Map<string, DelegateStatusRecord>();
  private counter = 0;
  private wakes: DelegateWakeStatus[] = [];

  constructor(private readonly onChange: () => void = () => {}) {}

  start(runs: readonly DelegatedRun[], kind: DelegateStatusKind): string[] {
    const ids = runs.map((inputRun) => {
      const run = serializeDelegateRunForPublic(inputRun);
      const id = `ds-${++this.counter}`;
      this.records.set(id, {
        id,
        runId: run.runId,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        lineageId: run.lineageId ?? run.continuation ?? id,
        name: run.name,
        kind,
        state: getRunState(run),
        createdAt: run.queuedAt ?? Date.now(),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        route: run.routing?.route,
        context: run.context,
        allowWrites: run.allowWrites === true,
        activity: displayActivity(run, undefined),
        transcript: transcript(run, inputRun.activities),
        result: resultProjection(inputRun),
        lifecycle: cloneDelegateLifecycle(run.lifecycle),
        ...(run.workflowAttempt
          ? {
              workflow: workflowStatusFromRun(
                run.workflowAttempt,
                getRunState(run),
                run,
              ),
            }
          : {}),
        resultEntered: false,
        clearOnNextUserMessage: false,
      });
      return id;
    });
    this.onChange();
    return ids;
  }

  update(id: string, inputRun: DelegatedRun): void {
    const run = serializeDelegateRunForPublic(inputRun);
    const record = this.records.get(id);
    if (!record) return;
    record.runId = run.runId;
    record.sessionId = run.sessionId;
    record.name = run.name;
    record.state = getRunState(run);
    record.startedAt = run.startedAt;
    record.finishedAt = run.finishedAt;
    record.route = run.routing?.route;
    record.context = run.context;
    record.allowWrites = run.allowWrites === true;
    record.activity = displayActivity(run, record.activity);
    record.transcript = transcript(run, inputRun.activities);
    record.result = resultProjection(inputRun);
    record.lifecycle = cloneDelegateLifecycle(run.lifecycle);
    if (run.workflowAttempt)
      record.workflow = workflowStatusFromRun(
        run.workflowAttempt,
        getRunState(run),
        run,
        record.workflow,
      );
    this.onChange();
  }

  updateMany(ids: readonly string[], runs: readonly DelegatedRun[]): void {
    let changed = false;
    for (const [index, id] of ids.entries()) {
      const record = this.records.get(id);
      const inputRun = runs[index];
      if (!record || !inputRun) continue;
      const run = serializeDelegateRunForPublic(inputRun);
      record.runId = run.runId;
      record.sessionId = run.sessionId;
      record.name = run.name;
      record.state = getRunState(run);
      record.startedAt = run.startedAt;
      record.finishedAt = run.finishedAt;
      record.route = run.routing?.route;
      record.context = run.context;
      record.allowWrites = run.allowWrites === true;
      record.activity = displayActivity(run, record.activity);
      record.transcript = transcript(run, inputRun.activities);
      record.result = resultProjection(inputRun);
      record.lifecycle = cloneDelegateLifecycle(run.lifecycle);
      if (run.workflowAttempt)
        record.workflow = workflowStatusFromRun(
          run.workflowAttempt,
          getRunState(run),
          run,
          record.workflow,
        );
      changed = true;
    }
    if (changed) this.onChange();
  }

  /** Attach the immutable logical attempt returned by the workflow coordinator. */
  setWorkflow(id: string, attempt: DelegateWorkflowAttemptSnapshot): void {
    const record = this.records.get(id);
    if (!record) return;
    record.workflow = workflowStatusFromAttempt(attempt, record.workflow);
    this.onChange();
  }

  /** Reconcile coordinator lifecycle state without importing result content. */
  updateWorkflow(attempts: readonly DelegateWorkflowAttemptSnapshot[]): void {
    const byIdentity = new Map(
      attempts.map((attempt) => [attempt.identity, attempt]),
    );
    let changed = false;
    for (const record of this.records.values()) {
      const identity = record.workflow?.identity;
      if (!identity) continue;
      const attempt = byIdentity.get(identity);
      if (!attempt) continue;
      record.workflow = workflowStatusFromAttempt(attempt, record.workflow);
      changed = true;
    }
    if (changed) this.onChange();
  }

  /** Mark exact attempts whose selected wake evidence entered parent context. */
  markWorkflowDelivered(identities: readonly string[]): void {
    const delivered = new Set(identities);
    let changed = false;
    for (const record of this.records.values()) {
      if (!record.workflow || !delivered.has(record.workflow.identity))
        continue;
      if (!record.workflow.deliveredToParent) {
        record.workflow = { ...record.workflow, deliveredToParent: true };
        changed = true;
      }
      if (!record.resultEntered) {
        record.resultEntered = true;
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /** Replace the active branch's wake metadata with a compact projection. */
  setWakes(wakes: readonly WakeSnapshot[]): void {
    const next = wakes.map((wake) => ({
      id: wake.id,
      state: wake.state,
      references: [...wake.references],
      ...(wake.state === 'pending'
        ? {
            waitingFor: [...wake.references].filter((identity) => {
              const workflow = [...this.records.values()].find(
                (record) => record.workflow?.identity === identity,
              )?.workflow;
              return !workflow || !isWorkflowTerminal(workflow.state);
            }),
          }
        : {}),
      createdAt: wake.createdAt,
      ...(wake.readyAt === undefined ? {} : { readyAt: wake.readyAt }),
      ...(wake.queuedAt === undefined ? {} : { queuedAt: wake.queuedAt }),
      ...(wake.enteredAt === undefined ? {} : { enteredAt: wake.enteredAt }),
      ...(wake.cancelledAt === undefined
        ? {}
        : { cancelledAt: wake.cancelledAt }),
      ...(wake.blockedAt === undefined ? {} : { blockedAt: wake.blockedAt }),
      ...(wake.reason ? { reason: wake.reason } : {}),
    }));
    if (JSON.stringify(next) === JSON.stringify(this.wakes)) return;
    this.wakes = next;
    this.onChange();
  }

  getWakes(): DelegateWakeStatus[] {
    return this.wakes.map((wake) => ({
      ...wake,
      references: [...wake.references],
      ...(wake.waitingFor ? { waitingFor: [...wake.waitingFor] } : {}),
    }));
  }

  setJobId(id: string, jobId: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.jobId = jobId;
    this.onChange();
  }

  setPauseState(
    id: string,
    pauseState: DelegatePauseState | undefined,
    pausedAt?: number,
  ): void {
    const record = this.records.get(id);
    if (!record) return;
    const effectivePausedAt = pauseState
      ? (pausedAt ?? record.pausedAt)
      : undefined;
    if (
      record.pauseState === pauseState &&
      record.pausedAt === effectivePausedAt
    )
      return;
    record.pauseState = pauseState;
    record.pausedAt = effectivePausedAt;
    this.onChange();
  }

  /** Remove statuses that were created for work which could not be started. */
  finish(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) changed = this.records.delete(id) || changed;
    if (changed) this.onChange();
  }

  /** Record that a settled result is now available to the parent agent. */
  resultEntered(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || !isSettled(record.state) || record.resultEntered) continue;
      record.resultEntered = true;
      changed = true;
    }
    if (changed) this.onChange();
  }

  /** Reconcile a background job that settled without a final run update. */
  settleJobs(
    jobs: readonly {
      id: string;
      state: DelegateRunState;
      settledAt?: number;
    }[],
  ): void {
    let changed = false;
    for (const job of jobs) {
      if (!isSettled(job.state)) continue;
      const record = [...this.records.values()].find(
        (candidate) => candidate.jobId === job.id,
      );
      if (!record || isSettled(record.state)) continue;
      record.state = job.state;
      record.finishedAt = job.settledAt ?? Date.now();
      changed = true;
    }
    if (changed) this.onChange();
  }

  /** Record explicit inspection of settled background jobs in this branch. */
  jobResultEntered(jobs: readonly string[]): void {
    const ids = [...this.records.values()]
      .filter((record) => record.jobId && jobs.includes(record.jobId))
      .map((record) => record.id);
    this.resultEntered(ids);
  }

  /** Arm complete, entered lineages only after the parent genuinely settles. */
  parentSettled(): void {
    const lineages = new Map<string, DelegateStatusRecord[]>();
    for (const record of this.records.values()) {
      const records = lineages.get(record.lineageId) ?? [];
      records.push(record);
      lineages.set(record.lineageId, records);
    }
    let changed = false;
    for (const records of lineages.values()) {
      if (
        !records.every(
          (record) => isSettled(record.state) && record.resultEntered,
        )
      )
        continue;
      for (const record of records) {
        if (record.clearOnNextUserMessage) continue;
        record.clearOnNextUserMessage = true;
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /** Clear armed lineages when the user submits the next fresh message. */
  parentUserMessage(): void {
    const ids = [...this.records.values()]
      .filter((record) => record.clearOnNextUserMessage)
      .map((record) => record.id);
    this.finish(ids);
  }

  list(): DelegateStatusSnapshot[] {
    const lineages = new Map<string, DelegateStatusRecord[]>();
    for (const record of this.records.values()) {
      const records = lineages.get(record.lineageId) ?? [];
      records.push(record);
      lineages.set(record.lineageId, records);
    }

    return [...lineages.values()].map((records) => {
      const ordered = [...records].sort(
        (left, right) => left.createdAt - right.createdAt,
      );
      const current =
        [...ordered].reverse().find((record) => record.state === 'running') ??
        [...ordered].reverse().find((record) => record.state === 'queued') ??
        ordered.at(-1);
      if (!current)
        throw new Error('Delegate status lineage unexpectedly has no runs.');
      const {
        resultEntered: _resultEntered,
        clearOnNextUserMessage: _clearOnNextUserMessage,
        runCount: _runCount,
        runs: _runs,
        transcript: _transcript,
        transcriptTruncated: _transcriptTruncated,
        result: _result,
        ...snapshot
      } = current;
      const fullTranscript = ordered.flatMap((record, runIndex) =>
        (record.transcript ?? []).map((entry) => ({
          ...entry,
          id: `${runIndex + 1}:${entry.id}`,
          run: runIndex + 1,
        })),
      );
      const boundedTranscript =
        fullTranscript.length <= MAX_TRANSCRIPT_ENTRIES
          ? fullTranscript
          : [
              fullTranscript[0],
              ...fullTranscript.slice(1 - MAX_TRANSCRIPT_ENTRIES),
            ];
      return {
        ...snapshot,
        id: ordered[0].id,
        createdAt: ordered[0].createdAt,
        runCount: ordered.length,
        runs: ordered.map((record) => ({
          state: record.state,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        })),
        transcript: boundedTranscript,
        ...(current.result ? { result: current.result } : {}),
        ...(boundedTranscript.length < fullTranscript.length
          ? { transcriptTruncated: true }
          : {}),
        activity: current.activity
          ? {
              ...current.activity,
              latestText: current.activity.latestText,
            }
          : undefined,
      };
    });
  }

  clear(): void {
    if (this.records.size === 0 && this.wakes.length === 0) return;
    this.records.clear();
    this.wakes = [];
    this.onChange();
  }
}
