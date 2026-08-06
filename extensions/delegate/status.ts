import { serializeDelegateRunForPublic } from './structured-result';
import type {
  DelegateContext,
  DelegatedActivity,
  DelegatedRun,
  DelegateRunState,
} from './types';
import { getRunState } from './types';

export type DelegateStatusKind = 'foreground' | 'background';

export interface DelegateStatusTiming {
  state: DelegateRunState;
  startedAt?: number;
  finishedAt?: number;
}

export interface DelegateTranscriptEntry {
  id: string;
  type: 'task' | 'thinking' | 'tool' | 'assistant' | 'error';
  label: string;
  text?: string;
  status?: 'running' | 'completed' | 'error';
  at?: number;
  run?: number;
}

export interface DelegateStatusSnapshot {
  id: string;
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
}

interface DelegateStatusRecord extends DelegateStatusSnapshot {
  /** Stable child-session identity shared by fresh and continued invocations. */
  lineageId: string;
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

function transcript(run: DelegatedRun): DelegateTranscriptEntry[] {
  const entries: DelegateTranscriptEntry[] = [
    {
      id: 'task',
      type: 'task',
      label: 'Task',
      text: run.task,
      status: 'completed',
      at: run.queuedAt,
    },
    ...run.activities.map((activity, index) => ({
      id: activity.id ?? `activity-${index}`,
      type: activity.type,
      label: activity.label,
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

  constructor(private readonly onChange: () => void = () => {}) {}

  start(runs: readonly DelegatedRun[], kind: DelegateStatusKind): string[] {
    const ids = runs.map((inputRun) => {
      const run = serializeDelegateRunForPublic(inputRun);
      const id = `ds-${++this.counter}`;
      this.records.set(id, {
        id,
        lineageId: run.continuation ?? id,
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
        transcript: transcript(run),
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
    record.name = run.name;
    record.state = getRunState(run);
    record.startedAt = run.startedAt;
    record.finishedAt = run.finishedAt;
    record.route = run.routing?.route;
    record.context = run.context;
    record.allowWrites = run.allowWrites === true;
    record.activity = displayActivity(run, record.activity);
    record.transcript = transcript(run);
    this.onChange();
  }

  updateMany(ids: readonly string[], runs: readonly DelegatedRun[]): void {
    let changed = false;
    for (const [index, id] of ids.entries()) {
      const record = this.records.get(id);
      const inputRun = runs[index];
      if (!record || !inputRun) continue;
      const run = serializeDelegateRunForPublic(inputRun);
      record.name = run.name;
      record.state = getRunState(run);
      record.startedAt = run.startedAt;
      record.finishedAt = run.finishedAt;
      record.route = run.routing?.route;
      record.context = run.context;
      record.allowWrites = run.allowWrites === true;
      record.activity = displayActivity(run, record.activity);
      record.transcript = transcript(run);
      changed = true;
    }
    if (changed) this.onChange();
  }

  setJobId(id: string, jobId: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.jobId = jobId;
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
        lineageId: _lineageId,
        resultEntered: _resultEntered,
        clearOnNextUserMessage: _clearOnNextUserMessage,
        runCount: _runCount,
        runs: _runs,
        transcript: _transcript,
        transcriptTruncated: _transcriptTruncated,
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
    if (this.records.size === 0) return;
    this.records.clear();
    this.onChange();
  }
}
