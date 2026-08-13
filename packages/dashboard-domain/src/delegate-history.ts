import type {
  DelegateHistoryDetails,
  DelegateHistoryGroup,
  DelegateHistoryInvocation,
  DelegateHistoryResponse,
  DelegateHistoryRunDetail,
  DelegateHistoryRunDetailResponse,
} from '@pi-dashboard/protocol';
import {
  MAX_DELEGATE_HISTORY_DETAIL_BYTES,
  MAX_DELEGATE_HISTORY_DETAIL_ENTRIES,
  MAX_DELEGATE_HISTORY_DETAIL_TEXT,
  MAX_DELEGATE_HISTORY_GROUPS,
  MAX_DELEGATE_HISTORY_RUNS_PER_GROUP,
  MAX_DELEGATE_HISTORY_SUMMARY_BYTES,
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

const PROJECTED_DETAILS: unique symbol = Symbol('delegate-history-details');
type ProjectedRun = RecordValue & {
  [PROJECTED_DETAILS]?: DelegateHistoryDetails;
};

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

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
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

function assistantResponse(run: RecordValue): string | undefined {
  if (!Array.isArray(run.messages)) return undefined;
  const messages = run.messages.flatMap((message) => {
    if (!isRecord(message) || message.role !== 'assistant') return [];
    if (typeof message.content === 'string') return [message.content];
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        ? [part.text]
        : [],
    );
  });
  const text = messages.join('\n').trim();
  return text.length > 0 ? text : undefined;
}

function hasAssistantText(run: RecordValue): boolean {
  return assistantResponse(run) !== undefined;
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
  const structuredResultIsValid =
    isRecord(run.structuredResult) && run.structuredResult.valid === true;
  if (
    run.stopReason === 'error' ||
    run.stopReason === 'aborted' ||
    (typeof run.exitCode === 'number' && run.exitCode !== 0) ||
    run.errorMessage ||
    (!hasAssistantText(run) && !structuredResultIsValid)
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
  const projected = (run as ProjectedRun)[PROJECTED_DETAILS];
  if (projected) return projected;
  const budget: DetailBudget = {
    remaining: MAX_DELEGATE_HISTORY_DETAIL_BYTES,
    truncated: false,
  };
  const details: RecordValue = {};
  const task = boundedString(run.task, MAX_DELEGATE_HISTORY_TASK, budget);
  if (task) details.task = task;
  const response = boundedString(
    assistantResponse(run),
    MAX_DELEGATE_HISTORY_DETAIL_TEXT,
    budget,
  );
  if (response) details.response = response;
  const error = boundedString(
    typeof run.errorMessage === 'string' ? run.errorMessage.trim() : undefined,
    MAX_DELEGATE_HISTORY_DETAIL_TEXT,
    budget,
  );
  if (error) details.error = error;
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

export interface DelegateHistoryEntryProjectionOptions {
  /** Parent session identity used for legacy entry-aware run IDs. */
  sessionId: string;
  /** Keep public detail data only for this selected run. */
  detailRunId?: string;
}

export interface DelegateHistoryEntryProjection {
  entry: unknown;
  truncated?: boolean;
  /** Includes bounded detail data carried outside JSON serialization. */
  retainedBytes?: number;
}

function projectedEntryMetadata(entry: RecordValue): RecordValue {
  const result: RecordValue = {};
  const type = stringValue(entry.type, 128);
  const id = stringValue(entry.id, 256);
  if (type) result.type = type;
  if (id) result.id = id;
  if (entry.parentId === null) result.parentId = null;
  else {
    const parentId = stringValue(entry.parentId, 256);
    if (parentId) result.parentId = parentId;
  }
  if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp))
    result.timestamp = entry.timestamp;
  else {
    const timestamp = stringValue(entry.timestamp, 128);
    if (timestamp) result.timestamp = timestamp;
  }
  return result;
}

function projectRun(
  run: RecordValue,
  entryIdentity: string | undefined,
  runIndex: string,
  options: DelegateHistoryEntryProjectionOptions,
  fallbackState?: unknown,
): { run: ProjectedRun; matches: boolean; detailBytes?: number } {
  const explicitRunId = stringValue(run.runId, 256);
  const runId =
    explicitRunId ??
    (entryIdentity === undefined
      ? undefined
      : compatibilityRunId(options.sessionId, entryIdentity, runIndex));
  const projected: ProjectedRun = {};
  if (runId) projected.runId = runId;
  const lineageId = stringValue(run.lineageId, 256);
  const continuation = stringValue(run.continuation, 4096);
  if (lineageId) projected.lineageId = lineageId;
  if (continuation) projected.continuation = continuation;
  const name = stringValue(run.name, 2_000);
  const task = stringValue(run.task, MAX_DELEGATE_HISTORY_TASK);
  if (name) projected.name = name;
  if (task) projected.task = task;
  projected.state = normalizedState(run, fallbackState);
  for (const key of ['queuedAt', 'startedAt', 'finishedAt'] as const) {
    const value = finiteNumber(run[key]);
    if (value !== undefined) projected[key] = value;
  }
  const jobId = stringValue(run.backgroundJobId, 256);
  if (jobId) projected.backgroundJobId = jobId;
  const route = isRecord(run.routing)
    ? stringValue(run.routing.route, 512)
    : undefined;
  if (route) projected.routing = { route };
  const context = validContext(run.context);
  if (context) projected.context = context;
  if (run.allowWrites === true) projected.allowWrites = true;
  if (isRecord(run.structuredResult))
    projected.structuredResult = { valid: run.structuredResult.valid === true };
  const hasError =
    typeof run.errorMessage === 'string' && run.errorMessage.trim().length > 0;
  if (hasError) projected.errorMessage = 'error';
  const matches = runId !== undefined && runId === options.detailRunId;
  if (matches) {
    const details = publicDetails(run);
    projected[PROJECTED_DETAILS] = details;
    return {
      run: projected,
      matches,
      detailBytes: serializedBytes(details),
    };
  }
  return { run: projected, matches };
}

function projectJobMetadata(job: RecordValue): RecordValue {
  const result: RecordValue = {};
  for (const [key, max] of [
    ['id', 256],
    ['name', 2_000],
    ['route', 512],
  ] as const) {
    const value = stringValue(job[key], max);
    if (value) result[key] = value;
  }
  const state = stringValue(job.state, 32);
  if (state) result.state = state;
  const settledAt = finiteNumber(job.settledAt);
  if (settledAt !== undefined) result.settledAt = settledAt;
  if (job.allowWrites === true) result.allowWrites = true;
  return result;
}

/**
 * Replace a delegate result with bounded metadata before selected-branch
 * storage. Summary scans keep no transcript payload; detail scans retain the
 * existing public projection for only the requested run.
 */
export function projectDelegateHistoryEntry(
  value: unknown,
  options: DelegateHistoryEntryProjectionOptions,
): DelegateHistoryEntryProjection {
  if (!isRecord(value)) return { entry: value };
  const result = projectedEntryMetadata(value);
  const entryIdentity = stringValue(value.id, 256);
  const sourceMessage = isRecord(value.message) ? value.message : value;
  if (
    sourceMessage.role === 'toolResult' &&
    sourceMessage.toolName === 'delegate' &&
    isRecord(sourceMessage.details) &&
    Array.isArray(sourceMessage.details.runs)
  ) {
    const runs: RecordValue[] = [];
    let detailBytes = 0;
    let truncated = false;
    for (const [runIndex, sourceRun] of sourceMessage.details.runs.entries()) {
      if (!isRecord(sourceRun)) continue;
      const projected = projectRun(
        sourceRun,
        entryIdentity,
        String(runIndex),
        options,
      );
      if (
        options.detailRunId !== undefined
          ? projected.matches
          : runs.length < MAX_DELEGATE_HISTORY_TOTAL_RUNS
      ) {
        runs.push(projected.run);
        detailBytes += projected.detailBytes ?? 0;
      } else truncated = true;
    }
    result.message = {
      role: 'toolResult',
      toolName: 'delegate',
      details: { runs },
    };
    return {
      entry: result,
      ...(truncated ? { truncated: true } : {}),
      retainedBytes: serializedBytes(result) + detailBytes,
    };
  }
  if (
    sourceMessage.customType === 'delegate-job-result' &&
    isRecord(sourceMessage.details) &&
    Array.isArray(sourceMessage.details.jobs)
  ) {
    const jobs: RecordValue[] = [];
    let runCount = 0;
    let detailBytes = 0;
    let truncated = false;
    for (const [jobIndex, sourceJob] of sourceMessage.details.jobs.entries()) {
      if (!isRecord(sourceJob) || !Array.isArray(sourceJob.runs)) continue;
      const projectedRuns: RecordValue[] = [];
      for (const [runIndex, sourceRun] of sourceJob.runs.entries()) {
        if (!isRecord(sourceRun)) continue;
        const projected = projectRun(
          sourceRun,
          entryIdentity,
          `${jobIndex}:${runIndex}`,
          options,
          sourceJob.state,
        );
        if (
          options.detailRunId !== undefined
            ? projected.matches
            : runCount < MAX_DELEGATE_HISTORY_TOTAL_RUNS
        ) {
          projectedRuns.push(projected.run);
          detailBytes += projected.detailBytes ?? 0;
          runCount += 1;
        } else truncated = true;
      }
      if (projectedRuns.length > 0)
        jobs.push({ ...projectJobMetadata(sourceJob), runs: projectedRuns });
    }
    const projectedMessage = {
      customType: 'delegate-job-result',
      details: { jobs },
    };
    if (isRecord(value.message)) result.message = projectedMessage;
    else result.customType = 'delegate-job-result';
    if (!isRecord(value.message)) result.details = projectedMessage.details;
    return {
      entry: result,
      ...(truncated ? { truncated: true } : {}),
      retainedBytes: serializedBytes(result) + detailBytes,
    };
  }
  return { entry: result };
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
  };
}

function detailInvocation(
  sessionId: string,
  occurrence: DelegateOccurrence,
): DelegateHistoryRunDetail {
  return {
    ...invocation(sessionId, occurrence),
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
  // Count and per-field limits are not sufficient when many run tasks are
  // unusually large. Trim oldest rows from the end until the summary itself
  // is bounded, preserving the stable IDs of rows that remain.
  while (
    JSON.stringify({
      version: 2,
      sessionId,
      ...(leafId ? { leafId } : {}),
      groups: grouped,
    }).length *
      4 >
      MAX_DELEGATE_HISTORY_SUMMARY_BYTES &&
    grouped.length > 0
  ) {
    const lastIndex = grouped.length - 1;
    const last = grouped[lastIndex];
    if (!last) break;
    const runs = last.runs.slice(0, -1);
    if (runs.length === 0) grouped.pop();
    else
      grouped[lastIndex] = {
        ...last,
        runId: runs[runs.length - 1]?.runId ?? last.runId,
        state: runs[runs.length - 1]?.state ?? last.state,
        runCount: runs.length,
        runs,
        truncated: true,
      };
    responseTruncated = true;
  }
  return {
    version: 2,
    sessionId,
    ...(leafId ? { leafId } : {}),
    ...(responseTruncated ? { truncated: true } : {}),
    groups: grouped,
  };
}

/**
 * Extract one selected invocation and its bounded public detail payload from a
 * parent-session branch. The caller must select/pin the branch before calling
 * this adapter; no child session or continuation data is exposed.
 */
export function delegateHistoryRunDetailFromBranch(
  sessionId: string,
  branch: readonly unknown[],
  runId: string,
  lineageId?: string,
  leafId?: string,
): DelegateHistoryRunDetailResponse {
  for (const occurrence of occurrences(branch)) {
    const summary = invocation(sessionId, occurrence);
    if (summary.runId !== runId) continue;
    if (lineageId !== undefined && summary.lineageId !== lineageId) continue;
    return {
      version: 1,
      sessionId,
      ...(leafId ? { leafId } : {}),
      lineageId: summary.lineageId,
      runId: summary.runId,
      run: detailInvocation(sessionId, occurrence),
    };
  }
  throw new Error('Delegate run was not found on the selected session branch.');
}

export const extractDelegateHistory = delegateHistoryFromBranch;
