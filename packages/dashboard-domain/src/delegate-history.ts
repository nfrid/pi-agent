import type {
  DelegateHistoryDetails,
  DelegateHistoryGroup,
  DelegateHistoryInvocation,
  DelegateHistoryResponse,
  DelegateHistoryRunDetail,
  DelegateHistoryRunDetailResponse,
} from '@pi-dashboard/protocol';
import {
  isCanonicalWorkflowAttemptReference,
  isCanonicalWorkflowLogicalId,
  MAX_DELEGATE_HISTORY_DETAIL_BYTES,
  MAX_DELEGATE_HISTORY_DETAIL_ENTRIES,
  MAX_DELEGATE_HISTORY_DETAIL_TEXT,
  MAX_DELEGATE_HISTORY_GROUPS,
  MAX_DELEGATE_HISTORY_RUNS_PER_GROUP,
  MAX_DELEGATE_HISTORY_SUMMARY_BYTES,
  MAX_DELEGATE_HISTORY_TASK,
  MAX_DELEGATE_HISTORY_TOTAL_RUNS,
  MAX_WORKFLOW_ATTEMPT_ORDINAL,
  MAX_WORKFLOW_DEPENDENCIES,
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
    state === 'timed-out' ||
    state === 'scheduled' ||
    state === 'cancelled' ||
    state === 'blocked'
  )
    return state;
  if (
    fallback === 'queued' ||
    fallback === 'running' ||
    fallback === 'success' ||
    fallback === 'error' ||
    fallback === 'aborted' ||
    fallback === 'timed-out' ||
    fallback === 'scheduled' ||
    fallback === 'cancelled' ||
    fallback === 'blocked'
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

function projectWorkflow(
  run: RecordValue,
  state: DelegateHistoryInvocation['state'],
  createdAt: number,
  route?: string,
): RecordValue | undefined {
  const hasWorkflowMetadata = run.workflow !== undefined;
  const source = hasWorkflowMetadata ? run.workflow : run.workflowAttempt;
  if (!isRecord(source)) return undefined;
  const ownerBranchId = validWorkflowText(source.ownerBranchId, 256);
  if (
    (source.ownerBranchId !== undefined && ownerBranchId === undefined) ||
    (hasWorkflowMetadata && source.dependencies === undefined)
  )
    return undefined;
  const logicalId = isCanonicalWorkflowLogicalId(source.logicalId)
    ? source.logicalId
    : undefined;
  const identity = isCanonicalWorkflowAttemptReference(source.identity)
    ? source.identity
    : undefined;
  const ordinal = source.ordinal;
  if (
    logicalId === undefined ||
    identity === undefined ||
    typeof ordinal !== 'number' ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > MAX_WORKFLOW_ATTEMPT_ORDINAL ||
    identity !== `${logicalId}@${ordinal}`
  )
    return undefined;
  const dependencies =
    source.dependencies === undefined
      ? []
      : Array.isArray(source.dependencies) &&
          source.dependencies.length <= MAX_WORKFLOW_DEPENDENCIES &&
          source.dependencies.every(isCanonicalWorkflowAttemptReference)
        ? (source.dependencies as string[])
        : undefined;
  if (
    dependencies === undefined ||
    new Set(dependencies).size !== dependencies.length ||
    dependencies.includes(identity)
  )
    return undefined;
  const waitingFor =
    source.waitingFor === undefined
      ? undefined
      : Array.isArray(source.waitingFor) &&
          source.waitingFor.length <= MAX_WORKFLOW_DEPENDENCIES &&
          source.waitingFor.every(isCanonicalWorkflowAttemptReference)
        ? (source.waitingFor as string[])
        : undefined;
  if (
    waitingFor !== undefined &&
    (new Set(waitingFor).size !== waitingFor.length ||
      waitingFor.some((reference) => !dependencies.includes(reference)))
  )
    return undefined;
  const reason =
    source.reason === undefined
      ? undefined
      : validWorkflowText(source.reason, 256);
  if (source.reason !== undefined && reason === undefined) return undefined;
  return {
    ...(ownerBranchId ? { ownerBranchId } : {}),
    logicalId,
    attempt: ordinal,
    identity,
    state,
    dependencies,
    ...(waitingFor?.length ? { waitingFor } : {}),
    ...(reason ? { reason } : {}),
    ...(route ? { route } : {}),
    createdAt,
    scheduledAt: finiteNumber(source.scheduledAt) ?? createdAt,
    ...(finiteNumber(source.queuedAt) === undefined
      ? {}
      : { queuedAt: source.queuedAt }),
    ...(finiteNumber(source.startedAt) === undefined
      ? {}
      : { startedAt: source.startedAt }),
    ...(finiteNumber(source.settledAt) === undefined
      ? {}
      : { settledAt: source.settledAt }),
  };
}

function projectRun(
  run: RecordValue,
  entryIdentity: string | undefined,
  runIndex: string,
  options: DelegateHistoryEntryProjectionOptions,
  fallbackState?: unknown,
  deriveCompatibilityId = true,
): { run: ProjectedRun; matches: boolean; detailBytes?: number } {
  const explicitRunId = stringValue(run.runId, 256);
  const runId =
    explicitRunId ??
    (deriveCompatibilityId && entryIdentity !== undefined
      ? compatibilityRunId(options.sessionId, entryIdentity, runIndex)
      : undefined);
  const projected: ProjectedRun = {};
  if (runId) projected.runId = runId;
  const childSessionId = stringValue(run.sessionId, 256);
  if (childSessionId) projected.sessionId = childSessionId;
  const lineageId = stringValue(run.lineageId, 256);
  const continuation = stringValue(run.continuation, 4096);
  if (lineageId) projected.lineageId = lineageId;
  if (continuation) projected.continuation = continuation;
  const name = stringValue(run.name, 2_000);
  const task = stringValue(run.task, MAX_DELEGATE_HISTORY_TASK);
  if (name) projected.name = name;
  if (task) projected.task = task;
  const projectedState = normalizedState(run, fallbackState);
  projected.state = projectedState;
  const projectedQueuedAt = finiteNumber(run.queuedAt);
  const projectedCreatedAt =
    projectedQueuedAt ?? finiteNumber(run.startedAt) ?? Date.now();
  const projectedRoute = isRecord(run.routing)
    ? stringValue(run.routing.route, 512)
    : undefined;
  const workflow = projectWorkflow(
    run,
    projectedState,
    projectedCreatedAt,
    projectedRoute,
  );
  if (workflow) projected.workflow = workflow;
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

const WORKFLOW_STORE_ENTRY_TYPE = 'delegate-workflow:v1';
const MAX_WORKFLOW_HISTORY_ATTEMPTS = 256;
const MAX_WORKFLOW_DELTA_ATTEMPTS = 32;
const WORKFLOW_STATES = new Set([
  'scheduled',
  'queued',
  'running',
  'success',
  'error',
  'timed-out',
  'aborted',
  'cancelled',
  'blocked',
]);

function validWorkflowText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    return undefined;
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return undefined;
  return value;
}

function projectWorkflowStoreAttempt(value: unknown): RecordValue | undefined {
  if (!isRecord(value)) return undefined;
  const ownerBranchId =
    value.ownerBranchId === undefined
      ? undefined
      : validWorkflowText(value.ownerBranchId, 256);
  const logicalId = isCanonicalWorkflowLogicalId(value.logicalId)
    ? value.logicalId
    : undefined;
  const identity = isCanonicalWorkflowAttemptReference(value.identity)
    ? value.identity
    : undefined;
  const attempt = value.attempt;
  const state = stringValue(value.state, 32);
  if (
    (value.ownerBranchId !== undefined && ownerBranchId === undefined) ||
    logicalId === undefined ||
    identity === undefined ||
    typeof attempt !== 'number' ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > MAX_WORKFLOW_ATTEMPT_ORDINAL ||
    identity !== `${logicalId}@${attempt}` ||
    !state ||
    !WORKFLOW_STATES.has(state) ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > MAX_WORKFLOW_DEPENDENCIES ||
    value.dependencies.some(
      (dependency) => !isCanonicalWorkflowAttemptReference(dependency),
    ) ||
    new Set(value.dependencies).size !== value.dependencies.length ||
    value.dependencies.includes(identity as string) ||
    !Array.isArray(value.waitingFor) ||
    value.waitingFor.length > MAX_WORKFLOW_DEPENDENCIES ||
    value.waitingFor.some(
      (dependency) => !isCanonicalWorkflowAttemptReference(dependency),
    ) ||
    new Set(value.waitingFor).size !== value.waitingFor.length ||
    value.waitingFor.some(
      (dependency) => !(value.dependencies as unknown[]).includes(dependency),
    )
  )
    return undefined;
  const dependencies = value.dependencies as string[];
  const waitingFor = value.waitingFor as string[];
  const createdAt = finiteNumber(value.createdAt);
  const scheduledAt = finiteNumber(value.scheduledAt);
  if (createdAt === undefined || scheduledAt === undefined) return undefined;
  for (const key of ['queuedAt', 'startedAt', 'settledAt'] as const)
    if (value[key] !== undefined && finiteNumber(value[key]) === undefined)
      return undefined;
  const route =
    value.route === undefined ? undefined : validWorkflowText(value.route, 512);
  const reason =
    value.reason === undefined
      ? undefined
      : validWorkflowText(value.reason, 256);
  if (value.route !== undefined && route === undefined) return undefined;
  if (value.reason !== undefined && reason === undefined) return undefined;
  if (value.allowWrites !== undefined && typeof value.allowWrites !== 'boolean')
    return undefined;
  const result: RecordValue = {
    ...(ownerBranchId ? { ownerBranchId } : {}),
    logicalId,
    attempt,
    identity,
    state,
    dependencies,
    waitingFor,
    createdAt,
    scheduledAt,
  };
  for (const key of ['queuedAt', 'startedAt', 'settledAt'] as const) {
    const timestamp = finiteNumber(value[key]);
    if (timestamp !== undefined) result[key] = timestamp;
  }
  if (route) result.route = route;
  if (typeof value.allowWrites === 'boolean')
    result.allowWrites = value.allowWrites;
  if (reason) result.reason = reason;
  return result;
}

type WorkflowStoreOperation = {
  kind: 'snapshot' | 'delta';
  attempts: RecordValue[];
};

/** null means this is not a workflow entry; undefined means malformed. */
function workflowStoreOperation(
  entry: RecordValue,
): WorkflowStoreOperation | null | undefined {
  if (entry.customType !== WORKFLOW_STORE_ENTRY_TYPE) return null;
  const data = isRecord(entry.data) ? entry.data : undefined;
  const state = data && isRecord(data.state) ? data.state : undefined;
  const kind = data?.kind;
  const max =
    kind === 'snapshot'
      ? MAX_WORKFLOW_HISTORY_ATTEMPTS
      : MAX_WORKFLOW_DELTA_ATTEMPTS;
  if (
    data?.version !== 1 ||
    (kind !== 'snapshot' && kind !== 'delta') ||
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.attempts) ||
    state.attempts.length > max
  )
    return undefined;
  const attempts: RecordValue[] = [];
  const keys = new Set<string>();
  for (const source of state.attempts) {
    const attempt = projectWorkflowStoreAttempt(source);
    if (!attempt) return undefined;
    const key = `${String(attempt.ownerBranchId ?? '')}\u0000${String(attempt.identity)}`;
    if (keys.has(key)) return undefined;
    keys.add(key);
    attempts.push(attempt);
  }
  return { kind, attempts };
}

function workflowStoreAttemptRun(metadata: RecordValue): RecordValue {
  const ownerBranchId = validWorkflowText(metadata.ownerBranchId, 256);
  const identity = String(metadata.identity);
  const logicalId = String(metadata.logicalId);
  const runId = ownerBranchId
    ? `workflow:${stableHash(`owner:${ownerBranchId}\u0000${identity}`)}`
    : identity;
  const lineageId = ownerBranchId
    ? `workflow:${stableHash(`owner:${ownerBranchId}\u0000${logicalId}`)}`
    : logicalId;
  return {
    runId,
    lineageId,
    name: logicalId,
    state: metadata.state,
    createdAt: metadata.createdAt,
    ...(metadata.queuedAt === undefined ? {} : { queuedAt: metadata.queuedAt }),
    ...(metadata.startedAt === undefined
      ? {}
      : { startedAt: metadata.startedAt }),
    ...(metadata.settledAt === undefined
      ? {}
      : { finishedAt: metadata.settledAt }),
    allowWrites: metadata.allowWrites === true,
    workflow: metadata,
  };
}

function workflowStoreAttempts(entry: RecordValue): RecordValue[] {
  const operation = workflowStoreOperation(entry);
  return operation?.attempts.map(workflowStoreAttemptRun) ?? [];
}

function projectWakeStoreSnapshot(value: unknown): RecordValue | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id, 256);
  const state = stringValue(value.state, 32);
  if (
    !id ||
    !state ||
    !['pending', 'ready', 'queued', 'entered', 'cancelled', 'blocked'].includes(
      state,
    ) ||
    !Array.isArray(value.references) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.dispatchAttempts !== 'number' ||
    !Number.isSafeInteger(value.dispatchAttempts) ||
    value.dispatchAttempts < 0
  )
    return undefined;
  const createdAt = finiteNumber(value.createdAt);
  if (createdAt === undefined) return undefined;
  const references = value.references.slice(0, 32).flatMap((reference) => {
    const result = stringValue(reference, 80);
    return result ? [result] : [];
  });
  const result: RecordValue = {
    id,
    state,
    references,
    createdAt,
    revision: value.revision,
    dispatchAttempts: value.dispatchAttempts,
  };
  for (const key of [
    'readyAt',
    'queuedAt',
    'enteredAt',
    'cancelledAt',
    'blockedAt',
  ] as const) {
    const timestamp = finiteNumber(value[key]);
    if (timestamp !== undefined) result[key] = timestamp;
  }
  const reason = stringValue(value.reason, 256);
  if (reason) result.reason = reason;
  return result;
}

const WAKE_STORE_ENTRY_TYPE = 'delegate-wake:v1';
const MAX_WAKE_HISTORY = 256;
const MAX_WAKE_DELTA_WAKES = 32;

type WakeStoreOperation = {
  kind: 'snapshot' | 'delta';
  wakes: RecordValue[];
  ownerSessionId?: string;
  ownerEpoch?: number;
};

function wakeStoreOperation(
  entry: RecordValue,
): WakeStoreOperation | null | undefined {
  if (entry.customType !== WAKE_STORE_ENTRY_TYPE) return null;
  const data = isRecord(entry.data) ? entry.data : undefined;
  const state = data && isRecord(data.state) ? data.state : undefined;
  const kind = data?.kind;
  const maximum = kind === 'snapshot' ? MAX_WAKE_HISTORY : MAX_WAKE_DELTA_WAKES;
  if (
    data?.version !== 1 ||
    (kind !== 'snapshot' && kind !== 'delta') ||
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.wakes) ||
    state.wakes.length > maximum
  )
    return undefined;
  const wakes: RecordValue[] = [];
  const wakeIds = new Set<string>();
  for (const wake of state.wakes) {
    const metadata = projectWakeStoreSnapshot(wake);
    const id = metadata ? stringValue(metadata.id, 256) : undefined;
    if (!metadata || !id || wakeIds.has(id)) return undefined;
    wakeIds.add(id);
    wakes.push(metadata);
  }
  const ownerSessionId = stringValue(state.ownerSessionId, 256);
  const ownerEpoch = finiteNumber(state.ownerEpoch);
  if (
    (state.ownerSessionId !== undefined && ownerSessionId === undefined) ||
    (state.ownerEpoch !== undefined &&
      (ownerEpoch === undefined ||
        !Number.isSafeInteger(ownerEpoch) ||
        ownerEpoch < 0))
  )
    return undefined;
  return {
    kind,
    wakes,
    ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
    ...(ownerEpoch === undefined ? {} : { ownerEpoch }),
  };
}

function wakeRun(metadata: RecordValue): RecordValue {
  const lifecycleState =
    metadata.state === 'entered'
      ? 'success'
      : metadata.state === 'cancelled' || metadata.state === 'blocked'
        ? 'error'
        : 'running';
  return {
    runId: `wake:${metadata.id}`,
    lineageId: `wake:${metadata.id}`,
    name: `Wake ${metadata.id}`,
    state: lifecycleState,
    createdAt: metadata.createdAt,
    ...(metadata.queuedAt === undefined ? {} : { queuedAt: metadata.queuedAt }),
    ...(metadata.enteredAt === undefined
      ? {}
      : { finishedAt: metadata.enteredAt }),
    allowWrites: false,
    wake: metadata,
  };
}

function wakeStoreEntries(entry: RecordValue): RecordValue[] {
  const operation = wakeStoreOperation(entry);
  return operation?.wakes.map(wakeRun) ?? [];
}

function projectWakeStoreEntry(entry: RecordValue): RecordValue | undefined {
  const operation = wakeStoreOperation(entry);
  if (!operation || operation.wakes.length === 0) return undefined;
  return {
    ...projectedEntryMetadata(entry),
    type: 'custom',
    customType: WAKE_STORE_ENTRY_TYPE,
    data: {
      version: 1,
      kind: operation.kind,
      state: {
        version: 1,
        ...(operation.ownerSessionId === undefined
          ? {}
          : { ownerSessionId: operation.ownerSessionId }),
        ...(operation.ownerEpoch === undefined
          ? {}
          : { ownerEpoch: operation.ownerEpoch }),
        wakes: operation.wakes,
      },
    },
  };
}

function projectWorkflowStoreEntry(
  entry: RecordValue,
): RecordValue | undefined {
  const operation = workflowStoreOperation(entry);
  if (!operation) return undefined;
  return {
    ...projectedEntryMetadata(entry),
    type: 'custom',
    customType: WORKFLOW_STORE_ENTRY_TYPE,
    data: {
      version: 1,
      kind: operation.kind,
      state: {
        version: 1,
        attempts: operation.attempts,
      },
    },
  };
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
  const workflowEntry = projectWorkflowStoreEntry(value);
  if (workflowEntry) return { entry: workflowEntry };
  const wakeEntry = projectWakeStoreEntry(value);
  if (wakeEntry) return { entry: wakeEntry };
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
      if (!isRecord(sourceJob)) continue;
      // A completion can be persisted with job metadata before its bounded run
      // payload is materialized. Retain one identity-only placeholder so the
      // domain can reconcile it with the queued launch by background job ID.
      const sourceRuns =
        Array.isArray(sourceJob.runs) && sourceJob.runs.length > 0
          ? sourceJob.runs
          : [undefined];
      const projectedRuns: RecordValue[] = [];
      for (const [runIndex, sourceRun] of sourceRuns.entries()) {
        if (sourceRun !== undefined && !isRecord(sourceRun)) continue;
        const synthetic = sourceRun === undefined;
        const projected = projectRun(
          synthetic ? {} : sourceRun,
          entryIdentity,
          `${jobIndex}:${runIndex}`,
          options,
          sourceJob.state,
          !synthetic,
        );
        const retain =
          options.detailRunId !== undefined
            ? projected.matches || synthetic
            : runCount < MAX_DELEGATE_HISTORY_TOTAL_RUNS;
        if (retain) {
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

function workflowDetails(
  entry: RecordValue,
  entryIndex: number,
): DelegateOccurrence[] {
  return [...workflowStoreAttempts(entry), ...wakeStoreEntries(entry)].map(
    (run, runIndex) => ({
      run,
      kind: 'background' as const,
      entryIndex,
      runIndex: String(runIndex),
      entryIdentity: stringValue(entry.id),
      entryTimestamp: entryTimestamp(entry),
    }),
  );
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
    if (!isRecord(job)) return;
    // Completion delivery may contain settled job state without a persisted
    // run array. The job itself is still durable settlement evidence.
    const runs =
      Array.isArray(job.runs) && job.runs.length > 0 ? job.runs : [{}];
    runs.forEach((run, runIndex) => {
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
    workflowDetails(value, 0).length > 0 ||
    foregroundDetails(value, 0).length > 0 ||
    backgroundDetails(value, 0).length > 0
  );
}

function workflowJournal(
  branch: readonly unknown[],
): DelegateOccurrence[] | undefined {
  const latest = new Map<string, DelegateOccurrence>();
  for (const [entryIndex, value] of branch.entries()) {
    if (!isRecord(value)) continue;
    const operation = workflowStoreOperation(value);
    // A malformed workflow record invalidates the complete metadata journal;
    // never render a valid prefix or an incomplete delta as current state.
    if (operation === undefined) return undefined;
    if (operation === null) continue;
    if (operation.kind === 'snapshot') latest.clear();
    for (const metadata of operation.attempts) {
      const owner = validWorkflowText(metadata.ownerBranchId, 256) ?? '';
      const identity = String(metadata.identity);
      const key = `workflow:${owner}\u0000${identity}`;
      latest.delete(key);
      latest.set(key, {
        run: workflowStoreAttemptRun(metadata),
        kind: 'background',
        entryIndex,
        runIndex: identity,
        entryIdentity: stringValue(value.id),
        entryTimestamp: entryTimestamp(value),
      });
    }
    while (latest.size > MAX_WORKFLOW_HISTORY_ATTEMPTS) {
      const oldest = latest.keys().next().value;
      if (oldest === undefined) break;
      latest.delete(oldest);
    }
  }
  return [...latest.values()];
}

function wakeStateProgress(state: unknown): number {
  if (state === 'pending') return 0;
  if (state === 'ready') return 1;
  if (state === 'queued') return 2;
  return 3;
}

function wakeIsTerminal(state: unknown): boolean {
  return state === 'entered' || state === 'cancelled' || state === 'blocked';
}

function keepPriorWakeOccurrence(
  previous: DelegateOccurrence,
  next: DelegateOccurrence,
): boolean {
  const oldWake = isRecord(previous.run.wake) ? previous.run.wake : undefined;
  const newWake = isRecord(next.run.wake) ? next.run.wake : undefined;
  if (!oldWake || !newWake) return false;
  const oldRevision = finiteNumber(oldWake.revision) ?? 0;
  const newRevision = finiteNumber(newWake.revision) ?? 0;
  if (oldRevision >= newRevision) return true;
  const oldProgress = wakeStateProgress(oldWake.state);
  const newProgress = wakeStateProgress(newWake.state);
  if (oldProgress > newProgress) return true;
  if (oldProgress === newProgress && oldWake.state !== newWake.state)
    return true;
  if (wakeIsTerminal(oldWake.state) && oldWake.state !== newWake.state)
    return true;
  if (oldWake.state === 'queued' && newWake.state !== 'queued') return true;
  return false;
}

function wakeJournal(
  branch: readonly unknown[],
): DelegateOccurrence[] | undefined {
  const latest = new Map<string, DelegateOccurrence>();
  let ownerKey: string | undefined;
  for (const [entryIndex, value] of branch.entries()) {
    if (!isRecord(value)) continue;
    const operation = wakeStoreOperation(value);
    // A malformed wake record invalidates the complete journal; do not render
    // a valid prefix or a partial delta as current state.
    if (operation === undefined) return undefined;
    if (operation === null) continue;
    const nextOwnerKey = `${operation.ownerSessionId ?? ''}\u0000${operation.ownerEpoch ?? ''}`;
    if (ownerKey !== undefined && ownerKey !== nextOwnerKey) latest.clear();
    ownerKey = nextOwnerKey;
    const occurrences = operation.wakes.map((metadata, runIndex) => ({
      run: wakeRun(metadata),
      kind: 'background' as const,
      entryIndex,
      runIndex: String(runIndex),
      entryIdentity: stringValue(value.id),
      entryTimestamp: entryTimestamp(value),
    }));
    if (operation.kind === 'snapshot') {
      const prior = new Map(latest);
      latest.clear();
      for (const occurrence of occurrences) {
        const wakeId = stringValue(
          (occurrence.run.wake as RecordValue).id,
          256,
        );
        if (!wakeId) continue;
        const key = `${nextOwnerKey}\u0000${wakeId}`;
        const previous = prior.get(key);
        latest.set(
          key,
          previous && keepPriorWakeOccurrence(previous, occurrence)
            ? previous
            : occurrence,
        );
      }
    } else {
      for (const occurrence of occurrences) {
        const wakeId = stringValue(
          (occurrence.run.wake as RecordValue).id,
          256,
        );
        if (!wakeId) continue;
        const key = `${nextOwnerKey}\u0000${wakeId}`;
        const previous = latest.get(key);
        if (!previous || !keepPriorWakeOccurrence(previous, occurrence))
          latest.set(key, occurrence);
      }
    }
    while (latest.size > MAX_WAKE_HISTORY) {
      const oldest = latest.keys().next().value;
      if (oldest === undefined) break;
      latest.delete(oldest);
    }
  }
  return [...latest.values()];
}

function occurrences(branch: readonly unknown[]): DelegateOccurrence[] {
  const ordinary: DelegateOccurrence[] = [];
  const workflow = workflowJournal(branch) ?? [];
  const wakes = wakeJournal(branch) ?? [];
  for (const [entryIndex, value] of branch.entries()) {
    if (!isRecord(value)) continue;
    ordinary.push(
      ...foregroundDetails(value, entryIndex),
      ...backgroundDetails(value, entryIndex),
    );
  }
  return [...ordinary, ...workflow, ...wakes].sort(
    (left, right) => left.entryIndex - right.entryIndex,
  );
}

/**
 * A background launch writes a queued/running tool result before its terminal
 * delegate-job-result. Modern runs keep the same explicit runId in both
 * records, but older/partially persisted records only retain the background
 * job ID. Reconcile on either identity so a settled completion cannot leave
 * its launch placeholder in the active section.
 */
function occurrenceJobId(occurrence: DelegateOccurrence): string | undefined {
  return (
    stringValue(occurrence.run.backgroundJobId, 256) ??
    stringValue(occurrence.job?.id, 256)
  );
}

function occurrenceKeys(occurrence: DelegateOccurrence): string[] {
  const keys: string[] = [];
  const runId = stringValue(occurrence.run.runId, 256);
  const jobId = occurrenceJobId(occurrence);
  if (runId) keys.push(`run:${runId}`);
  if (jobId) keys.push(`job:${jobId}`);
  return keys;
}

function occurrenceState(
  occurrence: DelegateOccurrence,
): DelegateHistoryInvocation['state'] {
  const jobState = stringValue(occurrence.job?.state, 32);
  // A delegate-job-result is itself the terminal record. Its aggregate job
  // state must settle an incompletely persisted run payload, even if that
  // payload still carries the queued placeholder state.
  if (
    occurrence.kind === 'background' &&
    jobState !== undefined &&
    jobState !== 'queued' &&
    jobState !== 'running'
  )
    return normalizedState({}, jobState);
  return normalizedState(occurrence.run, occurrence.job?.state);
}

function mergeCanonicalOccurrences(
  previous: DelegateOccurrence,
  next: DelegateOccurrence,
): DelegateOccurrence {
  const previousState = occurrenceState(previous);
  const nextState = occurrenceState(next);
  const previousTerminal =
    previousState !== 'queued' && previousState !== 'running';
  const nextTerminal = nextState !== 'queued' && nextState !== 'running';
  if (!nextTerminal && previousTerminal) return previous;
  if (!nextTerminal && !previousTerminal) return next;
  // Keep launch metadata (notably task and explicit run ID) when a terminal
  // job record has only bounded/partial payload, while terminal fields win.
  return {
    ...next,
    run: { ...previous.run, ...next.run },
    ...(next.job === undefined && previous.job === undefined
      ? {}
      : { job: next.job ?? previous.job }),
  };
}

function canonicalOccurrences(
  branch: readonly unknown[],
): DelegateOccurrence[] {
  const result: DelegateOccurrence[] = [];
  const indexes = new Map<string, number>();
  for (const occurrence of occurrences(branch)) {
    const keys = occurrenceKeys(occurrence);
    const index = keys
      .map((key) => indexes.get(key))
      .find((candidate): candidate is number => candidate !== undefined);
    if (index === undefined) {
      const nextIndex = result.length;
      result.push(occurrence);
      for (const key of keys) indexes.set(key, nextIndex);
      continue;
    }
    const previous = result[index];
    if (!previous) continue;
    const merged = mergeCanonicalOccurrences(previous, occurrence);
    result[index] = merged;
    for (const key of [...occurrenceKeys(previous), ...keys])
      indexes.set(key, index);
  }
  return result;
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
  const state = occurrenceState(occurrence);
  const childSessionId = stringValue(occurrence.run.sessionId, 256);
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
  const wakeSource = isRecord(occurrence.run.wake)
    ? occurrence.run.wake
    : undefined;
  const workflowSource = isRecord(occurrence.run.workflow)
    ? occurrence.run.workflow
    : undefined;
  const workflowOwnerBranchId = validWorkflowText(
    workflowSource?.ownerBranchId,
    256,
  );
  const workflowLogicalId = stringValue(workflowSource?.logicalId, 64);
  const workflowIdentity = stringValue(workflowSource?.identity, 80);
  const workflowAttempt = workflowSource?.attempt;
  const workflow =
    workflowSource &&
    workflowLogicalId &&
    workflowIdentity &&
    typeof workflowAttempt === 'number' &&
    Number.isSafeInteger(workflowAttempt) &&
    workflowAttempt >= 1
      ? {
          ...(workflowOwnerBranchId
            ? { ownerBranchId: workflowOwnerBranchId }
            : {}),
          logicalId: workflowLogicalId,
          attempt: workflowAttempt,
          identity: workflowIdentity,
          dependencies: Array.isArray(workflowSource.dependencies)
            ? workflowSource.dependencies.flatMap((value) =>
                typeof value === 'string' ? [value] : [],
              )
            : [],
          ...(Array.isArray(workflowSource.waitingFor) &&
          workflowSource.waitingFor.length > 0
            ? {
                waitingFor: workflowSource.waitingFor.filter(
                  (value): value is string => typeof value === 'string',
                ),
              }
            : {}),
          state,
          createdAt,
          scheduledAt: finiteNumber(workflowSource.scheduledAt) ?? createdAt,
          ...(finiteNumber(workflowSource.queuedAt) === undefined
            ? {}
            : { queuedAt: workflowSource.queuedAt }),
          ...(finiteNumber(workflowSource.startedAt) === undefined
            ? {}
            : { startedAt: workflowSource.startedAt }),
          ...(finiteNumber(workflowSource.settledAt) === undefined
            ? {}
            : { settledAt: workflowSource.settledAt }),
          ...(typeof workflowSource.reason === 'string'
            ? { reason: workflowSource.reason.slice(0, 256) }
            : {}),
          ...(typeof workflowSource.allowWrites === 'boolean'
            ? { allowWrites: workflowSource.allowWrites }
            : {}),
          ...(route === undefined ? {} : { route }),
        }
      : undefined;
  return {
    runId,
    ...(childSessionId === undefined ? {} : { sessionId: childSessionId }),
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
    ...(workflow
      ? { workflow: workflow as DelegateHistoryInvocation['workflow'] }
      : {}),
    ...(wakeSource
      ? { wake: wakeSource as DelegateHistoryInvocation['wake'] }
      : {}),
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

function aggregateHistoryGroup(
  lineageId: string,
  runs: readonly DelegateHistoryInvocation[],
  truncated: boolean,
): DelegateHistoryGroup {
  const first = runs[0];
  const current = runs.at(-1);
  if (!first || !current) throw new Error('Delegate history lineage is empty.');
  return {
    id: lineageId,
    runId: current.runId,
    ...(current.sessionId === undefined
      ? {}
      : { sessionId: current.sessionId }),
    lineageId,
    name: current.name,
    kind: current.kind,
    state: current.state,
    createdAt: first.createdAt,
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
    ...(current.workflow ? { workflow: current.workflow } : {}),
    ...(current.wake ? { wake: current.wake } : {}),
    runCount: runs.length,
    runs: [...runs],
    ...(truncated ? { truncated: true } : {}),
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
  const orderedRuns: { lineageId: string; runId: string }[] = [];
  let totalRuns = 0;
  let responseTruncated = options.truncated === true;
  for (const occurrence of canonicalOccurrences(branch)) {
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
    orderedRuns.push({ lineageId: run.lineageId, runId: run.runId });
    totalRuns += 1;
  }

  const buildGroups = (): DelegateHistoryGroup[] =>
    [...groups.entries()].flatMap(([lineageId, group]) =>
      group.runs.length > 0
        ? [aggregateHistoryGroup(lineageId, group.runs, group.truncated)]
        : [],
    );
  let grouped = buildGroups();
  // Count and per-field limits are not sufficient when many run tasks are
  // unusually large. Remove the oldest accepted runs/groups first while
  // retaining the newest accepted run, then rebuild every aggregate field from
  // the survivors.
  const newestRunIndex = orderedRuns.length - 1;
  let trimIndex = 0;
  while (
    JSON.stringify({
      version: 2,
      sessionId,
      ...(leafId ? { leafId } : {}),
      groups: grouped,
    }).length *
      4 >
      MAX_DELEGATE_HISTORY_SUMMARY_BYTES &&
    grouped.length > 0 &&
    trimIndex < orderedRuns.length
  ) {
    const candidate = orderedRuns[trimIndex];
    trimIndex += 1;
    if (!candidate || trimIndex - 1 === newestRunIndex) continue;
    const group = groups.get(candidate.lineageId);
    if (!group) continue;
    const runIndex = group.runs.findIndex(
      (run) => run.runId === candidate.runId,
    );
    if (runIndex < 0) continue;
    group.runs.splice(runIndex, 1);
    group.truncated = true;
    grouped = buildGroups();
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
  for (const occurrence of canonicalOccurrences(branch)) {
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
