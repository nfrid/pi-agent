import type {
  DelegateHistoryDetails,
  DelegateHistoryGroup,
  DelegateHistoryInvocation,
  DelegateHistoryResponse,
} from '@pi-dashboard/protocol';
import {
  MAX_DELEGATE_HISTORY_DETAIL_BYTES,
  MAX_DELEGATE_HISTORY_DETAIL_ENTRIES,
  MAX_DELEGATE_HISTORY_DETAIL_TEXT,
  MAX_DELEGATE_HISTORY_GROUPS,
  MAX_DELEGATE_HISTORY_RUNS_PER_GROUP,
  MAX_DELEGATE_HISTORY_TASK,
  MAX_DELEGATE_HISTORY_TOTAL_RUNS,
} from '@pi-dashboard/protocol';

/**
 * This adapter intentionally understands only the parent-visible delegate
 * detail envelopes. It does not read child sessions or depend on the delegate
 * extension, so offline history remains a dashboard-domain concern.
 */
interface RecordValue {
  [key: string]: unknown;
}

type DelegateOccurrence = {
  run: RecordValue;
  kind: 'foreground' | 'background';
  entryIndex: number;
  runIndex: string;
  entryIdentity?: string;
  job?: RecordValue;
  entryTimestamp?: number;
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(
  value: unknown,
  max = Number.POSITIVE_INFINITY,
): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, max)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function entryTimestamp(entry: RecordValue): number | undefined {
  const direct = finiteNumber(entry.timestamp);
  if (direct !== undefined) return direct;
  return typeof entry.timestamp === 'string'
    ? finiteNumber(Date.parse(entry.timestamp))
    : undefined;
}

function stableHash(value: string): string {
  // Two independent FNV-style lanes give a stable, browser-safe compatibility
  // identity without making the dashboard server depend on Node crypto.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

// Legacy extension run IDs were derived from run facts alone. The server
// additionally has the durable parent entry identity, so old live and
// persisted run IDs cannot be reconciled safely in every case; use the shared
// lineage identity for that boundary and keep entry-aware IDs collision-safe.
function compatibilityRunId(
  sessionId: string,
  entryIdentity: string,
  runIndex: string,
): string {
  return `dr-${stableHash(`delegate-run:${sessionId}:${entryIdentity}:${runIndex}`)}`;
}

function compatibilityLineageId(continuation: string): string {
  return `dl-${stableHash(`delegate-lineage:${continuation}`)}`;
}

function hasAssistantText(run: RecordValue): boolean {
  if (!Array.isArray(run.messages)) return false;
  return run.messages.some((message) => {
    if (!isRecord(message) || message.role !== 'assistant') return false;
    if (typeof message.content === 'string')
      return message.content.trim().length > 0;
    if (!Array.isArray(message.content)) return false;
    return message.content.some(
      (part) =>
        isRecord(part) &&
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.trim().length > 0,
    );
  });
}

function normalizedState(
  run: RecordValue,
  fallback?: unknown,
): DelegateHistoryInvocation['state'] {
  const state = stringValue(run.state);
  if (
    state === 'queued' ||
    state === 'running' ||
    state === 'success' ||
    state === 'error' ||
    state === 'aborted' ||
    state === 'timed-out'
  )
    return state;
  if (
    fallback === 'queued' ||
    fallback === 'running' ||
    fallback === 'success' ||
    fallback === 'error' ||
    fallback === 'aborted' ||
    fallback === 'timed-out'
  )
    return fallback;
  if (run.exitCode === -1) return 'running';
  if (run.stopReason === 'aborted') return 'aborted';
  if (run.exitCode === 124) return 'timed-out';
  if (
    run.stopReason === 'error' ||
    run.stopReason === 'aborted' ||
    (typeof run.exitCode === 'number' && run.exitCode !== 0) ||
    run.errorMessage ||
    !hasAssistantText(run)
  )
    return 'error';
  return 'success';
}

function validContext(
  value: unknown,
): 'branch' | 'fresh' | 'continuation' | undefined {
  return value === 'branch' || value === 'fresh' || value === 'continuation'
    ? value
    : undefined;
}

interface DetailBudget {
  remaining: number;
  truncated: boolean;
}

function boundedString(
  value: unknown,
  max: number,
  budget: DetailBudget,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  // Reserve four bytes per UTF-16 code unit so the in-memory UTF-8 JSON
  // representation stays below the protocol's byte budget for non-ASCII text.
  const limit = Math.min(max, Math.floor(budget.remaining / 4));
  if (limit <= 0) {
    budget.truncated = true;
    return undefined;
  }
  const result = value.slice(0, limit);
  budget.remaining -= result.length * 4;
  if (result.length < value.length) budget.truncated = true;
  return result;
}

function boundedValue(
  value: unknown,
  depth: number,
  budget: DetailBudget,
): unknown {
  if (value === undefined) return undefined;
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return undefined;
  }
  if (value === null || typeof value === 'boolean') {
    budget.remaining -= 8;
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      budget.truncated = true;
      return undefined;
    }
    budget.remaining -= 24;
    return value;
  }
  if (typeof value === 'string')
    return boundedString(value, MAX_DELEGATE_HISTORY_DETAIL_TEXT, budget);
  if (depth <= 0) {
    budget.truncated = true;
    return undefined;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value.slice(0, 32)) {
      const bounded = boundedValue(item, depth - 1, budget);
      if (bounded !== undefined) result.push(bounded);
      if (budget.remaining <= 0) break;
    }
    if (value.length > 32) budget.truncated = true;
    return result;
  }
  if (isRecord(value)) {
    const result: RecordValue = {};
    const fields = Object.entries(value);
    for (const [key, item] of fields.slice(0, 32)) {
      const boundedKey = boundedString(key, 128, budget);
      const bounded = boundedValue(item, depth - 1, budget);
      if (bounded !== undefined && boundedKey !== undefined)
        result[boundedKey] = bounded;
      if (budget.remaining <= 0) break;
    }
    if (fields.length > 32) budget.truncated = true;
    return result;
  }
  budget.truncated = true;
  return undefined;
}

function boundedActivity(
  value: unknown,
  budget: DetailBudget,
): RecordValue | undefined {
  if (!isRecord(value)) {
    budget.truncated = true;
    return undefined;
  }
  const type =
    value.type === 'thinking' || value.type === 'tool' ? value.type : undefined;
  const label = boundedString(value.label, 2_000, budget);
  if (!type || !label) {
    budget.truncated = true;
    return undefined;
  }
  const activity: RecordValue = { type, label };
  const id = boundedString(value.id, 512, budget);
  const name = boundedString(value.toolName, 256, budget);
  const text = boundedString(
    value.transcriptText ?? value.latestText,
    MAX_DELEGATE_HISTORY_DETAIL_TEXT,
    budget,
  );
  if (id) activity.id = id;
  if (name) activity.name = name;
  if (text) activity.text = text;
  const argumentsValue = boundedValue(value.toolArguments, 6, budget);
  const resultValue = boundedValue(value.toolResult, 6, budget);
  if (argumentsValue !== undefined) activity.arguments = argumentsValue;
  if (resultValue !== undefined) activity.result = resultValue;
  if (value.toolArgumentsTruncated === true) activity.argumentsTruncated = true;
  if (value.toolResultTruncated === true) activity.resultTruncated = true;
  if (
    value.status === 'running' ||
    value.status === 'completed' ||
    value.status === 'error'
  )
    activity.status = value.status;
  const at = finiteNumber(value.startedAt);
  if (at !== undefined) activity.at = at;
  return activity;
}

function publicDetails(run: RecordValue): DelegateHistoryDetails {
  const budget: DetailBudget = {
    remaining: MAX_DELEGATE_HISTORY_DETAIL_BYTES,
    truncated: false,
  };
  const details: RecordValue = {};
  const task = boundedString(run.task, MAX_DELEGATE_HISTORY_TASK, budget);
  if (task) details.task = task;
  if (Array.isArray(run.activities)) {
    const activities: RecordValue[] = [];
    for (const activity of run.activities.slice(
      0,
      MAX_DELEGATE_HISTORY_DETAIL_ENTRIES,
    )) {
      const bounded = boundedActivity(activity, budget);
      if (bounded) activities.push(bounded);
      if (budget.remaining <= 0) break;
    }
    details.activities = activities;
    if (run.activities.length > MAX_DELEGATE_HISTORY_DETAIL_ENTRIES)
      budget.truncated = true;
  }
  if (isRecord(run.structuredResult)) {
    const structured: RecordValue = {
      valid: run.structuredResult.valid === true,
      errors: Array.isArray(run.structuredResult.errors)
        ? run.structuredResult.errors.slice(0, 16).flatMap((error) => {
            const text = boundedString(error, 240, budget);
            return text ? [text] : [];
          })
        : [],
    };
    if (
      Array.isArray(run.structuredResult.errors) &&
      run.structuredResult.errors.length > 16
    )
      budget.truncated = true;
    const value = boundedValue(run.structuredResult.value, 6, budget);
    if (value !== undefined) structured.value = value;
    if (run.structuredResult.valueOmitted === true)
      structured.valueOmitted = true;
    details.structuredResult = structured;
  }
  if (isRecord(run.lifecycle)) {
    const reason = boundedString(run.lifecycle.reason, 128, budget);
    const diagnostic = boundedString(
      run.lifecycle.diagnostic,
      MAX_DELEGATE_HISTORY_DETAIL_TEXT,
      budget,
    );
    if (reason) {
      details.lifecycle = {
        reason,
        ...(diagnostic === undefined ? {} : { diagnostic }),
        continuationUsable: run.lifecycle.continuationUsable === true,
        writableBranchRetained: run.lifecycle.writableBranchRetained === true,
        readOnlySnapshotRetained:
          run.lifecycle.readOnlySnapshotRetained === true,
      };
    }
  }
  if (Array.isArray(run.warnings)) {
    details.warnings = run.warnings.slice(0, 32).flatMap((warning) => {
      const text = boundedString(warning, 512, budget);
      return text ? [text] : [];
    });
    if (run.warnings.length > 32) budget.truncated = true;
  }
  details.truncated = budget.truncated;
  if (JSON.stringify(details).length * 4 > MAX_DELEGATE_HISTORY_DETAIL_BYTES)
    return { truncated: true };
  return details as DelegateHistoryDetails;
}

function foregroundDetails(
  entry: RecordValue,
  entryIndex: number,
): DelegateOccurrence[] {
  if (!isRecord(entry.message)) return [];
  const message = entry.message;
  if (
    message.role !== 'toolResult' ||
    message.toolName !== 'delegate' ||
    !isRecord(message.details) ||
    !Array.isArray(message.details.runs)
  )
    return [];
  return message.details.runs.flatMap((run, runIndex) =>
    isRecord(run)
      ? [
          {
            run,
            kind: 'foreground' as const,
            entryIndex,
            runIndex: String(runIndex),
            entryIdentity: stringValue(entry.id),
            entryTimestamp: entryTimestamp(entry),
          },
        ]
      : [],
  );
}

function backgroundDetails(
  entry: RecordValue,
  entryIndex: number,
): DelegateOccurrence[] {
  const message = isRecord(entry.message) ? entry.message : entry;
  if (
    message.customType !== 'delegate-job-result' ||
    !isRecord(message.details)
  )
    return [];
  const jobs = message.details.jobs;
  if (!Array.isArray(jobs)) return [];
  const occurrences: DelegateOccurrence[] = [];
  jobs.forEach((job, jobIndex) => {
    if (!isRecord(job) || !Array.isArray(job.runs)) return;
    job.runs.forEach((run, runIndex) => {
      if (!isRecord(run)) return;
      occurrences.push({
        run,
        kind: 'background',
        entryIndex,
        runIndex: `${jobIndex}:${runIndex}`,
        entryIdentity: stringValue(entry.id),
        job,
        entryTimestamp: entryTimestamp(entry),
      });
    });
  });
  return occurrences;
}

export function isDelegateHistoryEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    foregroundDetails(value, 0).length > 0 ||
    backgroundDetails(value, 0).length > 0
  );
}

function occurrences(branch: readonly unknown[]): DelegateOccurrence[] {
  return branch.flatMap((value, entryIndex) => {
    if (!isRecord(value)) return [];
    return [
      ...foregroundDetails(value, entryIndex),
      ...backgroundDetails(value, entryIndex),
    ];
  });
}

function invocation(
  sessionId: string,
  occurrence: DelegateOccurrence,
): DelegateHistoryInvocation {
  const entryIdentity =
    occurrence.entryIdentity ?? `branch-entry-${occurrence.entryIndex}`;
  const explicitRunId = stringValue(occurrence.run.runId, 256);
  const runId =
    explicitRunId ??
    compatibilityRunId(sessionId, entryIdentity, occurrence.runIndex);
  const continuation = stringValue(occurrence.run.continuation, 4096);
  const explicitLineageId = stringValue(occurrence.run.lineageId, 256);
  const lineageId =
    explicitLineageId ??
    (continuation ? compatibilityLineageId(continuation) : runId);
  const state = normalizedState(occurrence.run, occurrence.job?.state);
  const name =
    stringValue(occurrence.run.name, 2_000) ??
    stringValue(occurrence.job?.name, 2_000) ??
    'Subagent';
  const queuedAt = finiteNumber(occurrence.run.queuedAt);
  const startedAt = finiteNumber(occurrence.run.startedAt);
  const finishedAt =
    finiteNumber(occurrence.run.finishedAt) ??
    finiteNumber(occurrence.job?.settledAt);
  const createdAt =
    queuedAt ??
    startedAt ??
    finishedAt ??
    occurrence.entryTimestamp ??
    occurrence.entryIndex;
  const jobId =
    stringValue(occurrence.run.backgroundJobId, 256) ??
    stringValue(occurrence.job?.id, 256);
  const route =
    (isRecord(occurrence.run.routing)
      ? stringValue(occurrence.run.routing.route, 512)
      : undefined) ?? stringValue(occurrence.job?.route, 512);
  const context = validContext(occurrence.run.context);
  const task = stringValue(occurrence.run.task, MAX_DELEGATE_HISTORY_TASK);
  const allowWrites =
    occurrence.run.allowWrites === true || occurrence.job?.allowWrites === true;
  return {
    runId,
    lineageId,
    name,
    ...(task === undefined ? {} : { task }),
    kind: occurrence.kind,
    state,
    createdAt,
    ...(queuedAt === undefined ? {} : { queuedAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(route === undefined ? {} : { route }),
    ...(context === undefined ? {} : { context }),
    allowWrites,
    details: publicDetails(occurrence.run),
  };
}

/**
 * Extract all parent-persisted delegate invocations from one selected branch.
 * Branch entries must already have been selected by SessionIndex.
 */
export function delegateHistoryFromBranch(
  sessionId: string,
  branch: readonly unknown[],
  leafId?: string,
  options: { truncated?: boolean } = {},
): DelegateHistoryResponse {
  const groups = new Map<
    string,
    { runs: DelegateHistoryInvocation[]; truncated: boolean }
  >();
  let totalRuns = 0;
  let responseTruncated = options.truncated === true;
  for (const occurrence of occurrences(branch)) {
    const run = invocation(sessionId, occurrence);
    let group = groups.get(run.lineageId);
    if (!group) {
      if (
        groups.size >= MAX_DELEGATE_HISTORY_GROUPS ||
        totalRuns >= MAX_DELEGATE_HISTORY_TOTAL_RUNS
      ) {
        responseTruncated = true;
        continue;
      }
      group = { runs: [], truncated: false };
      groups.set(run.lineageId, group);
    }
    if (
      group.runs.length >= MAX_DELEGATE_HISTORY_RUNS_PER_GROUP ||
      totalRuns >= MAX_DELEGATE_HISTORY_TOTAL_RUNS
    ) {
      group.truncated = true;
      responseTruncated = true;
      continue;
    }
    group.runs.push(run);
    totalRuns += 1;
  }

  const grouped: DelegateHistoryGroup[] = [...groups.entries()].map(
    ([lineageId, group]) => {
      const { runs } = group;
      const current = runs[runs.length - 1];
      // The map cannot contain an empty list, but retain a defensive guard so
      // malformed future adapters cannot create an invalid protocol response.
      if (!current) throw new Error('Delegate history lineage is empty.');
      return {
        id: lineageId,
        runId: current.runId,
        lineageId,
        name: current.name,
        kind: current.kind,
        state: current.state,
        createdAt: runs[0]?.createdAt ?? current.createdAt,
        ...(current.startedAt === undefined
          ? {}
          : { startedAt: current.startedAt }),
        ...(current.finishedAt === undefined
          ? {}
          : { finishedAt: current.finishedAt }),
        ...(current.jobId === undefined ? {} : { jobId: current.jobId }),
        ...(current.route === undefined ? {} : { route: current.route }),
        ...(current.context === undefined ? {} : { context: current.context }),
        allowWrites: current.allowWrites,
        runCount: runs.length,
        runs,
        ...(group.truncated ? { truncated: true } : {}),
      };
    },
  );
  return {
    version: 1,
    sessionId,
    ...(leafId ? { leafId } : {}),
    ...(responseTruncated ? { truncated: true } : {}),
    groups: grouped,
  };
}

export const extractDelegateHistory = delegateHistoryFromBranch;
