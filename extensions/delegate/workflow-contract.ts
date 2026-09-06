import {
  cloneDelegateLifecycle,
  ensureDelegateLifecycle,
  getDelegateLifecycle,
} from './lifecycle';
import {
  type DelegatedRun,
  type DelegateWorkflowBranchDescriptor,
  type DelegateWorkflowResultRecord,
  type DelegateWorkflowRunProjection,
  type DelegateWorkflowTextEvidence,
  getExactFinalAssistantText,
} from './types';
import { isLogicalId, MAX_ATTEMPT_ORDINAL } from './workflow-model';

export const WORKFLOW_INPUT_CAPS = {
  perItemMaxBytes: 16 * 1024,
  aggregateMaxBytes: 48 * 1024,
} as const;

/** A marker is retained instead of clipping evidence that cannot be forwarded. */
export const WORKFLOW_OVERSIZED_EVIDENCE_MARKER =
  '[oversized workflow evidence omitted]' as const;

export const MAX_WORKFLOW_TOKEN_BYTES = 16 * 1024;
export const MAX_WORKFLOW_TERMINAL_FIELD_BYTES = 1024;
export const MAX_WORKFLOW_RESULT_RUNS = 32;
export const MAX_WORKFLOW_RESULT_BYTES = 64 * 1024;

/** Capture exact text only when it fits the existing raw per-item bound. */
export function captureWorkflowText(
  value: string,
): DelegateWorkflowTextEvidence {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= WORKFLOW_INPUT_CAPS.perItemMaxBytes)
    return Object.freeze({ text: value, bytes });
  return Object.freeze({
    text: WORKFLOW_OVERSIZED_EVIDENCE_MARKER,
    bytes,
    oversized: true as const,
  });
}

function boundedTerminalField(value: string, fallback: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_WORKFLOW_TERMINAL_FIELD_BYTES)
    return value;
  return fallback;
}

function copyBranch(
  worktree: DelegatedRun['worktree'],
): DelegateWorkflowBranchDescriptor | undefined {
  if (!worktree) return undefined;
  const within = (value: unknown, maxBytes: number): value is string =>
    typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
  if (
    !within(worktree.id, 128) ||
    !within(worktree.repositoryRoot, 4096) ||
    !within(worktree.worktreePath, 4096) ||
    !within(worktree.branch, 512) ||
    (worktree.headCommit !== undefined && !within(worktree.headCommit, 128))
  )
    return undefined;
  return Object.freeze({
    id: worktree.id,
    repositoryRoot: worktree.repositoryRoot,
    worktreePath: worktree.worktreePath,
    branch: worktree.branch,
    ...(worktree.headCommit === undefined
      ? {}
      : { headCommit: worktree.headCommit }),
  });
}

function copyOutputFile(
  value: DelegatedRun['outputFile'],
): DelegatedRun['outputFile'] {
  return value ? Object.freeze({ ...value }) : undefined;
}

/** Build the bounded live evidence contract from a job result. */
type WorkflowResultSource = {
  readonly runs: readonly DelegatedRun[];
  readonly handoff: string;
  readonly retainedRuns?: readonly DelegatedRun[];
};

export function compactWorkflowResult(
  result: WorkflowResultSource,
): DelegateWorkflowResultRecord {
  const sourceRuns = result.retainedRuns ?? result.runs;
  const runs = Object.freeze(
    sourceRuns.map((run): DelegateWorkflowRunProjection => {
      const lifecycle =
        ['error', 'aborted', 'timed-out'].includes(run.state) &&
        !getDelegateLifecycle(run)
          ? ensureDelegateLifecycle(run)
          : getDelegateLifecycle(run, {
              includeFile: true,
              includeBoundedFallback: true,
            });
      const compactLifecycle = lifecycle
        ? cloneDelegateLifecycle(lifecycle, { includeFile: true })
        : undefined;
      const report = (() => {
        const text = getExactFinalAssistantText(run.messages);
        return text.trim() ? captureWorkflowText(text) : undefined;
      })();
      const continuation = run.continuation?.trim();
      const worktree = copyBranch(run.worktree);
      const outputFile = copyOutputFile(run.outputFile);
      return Object.freeze({
        runId: boundedTerminalField(run.runId, 'unknown-run'),
        name: boundedTerminalField(run.name, 'Subagent'),
        task: boundedTerminalField(run.task, '[oversized task omitted]'),
        exitCode: run.exitCode,
        state: run.state,
        ...(run.model
          ? {
              model: boundedTerminalField(
                run.model,
                '[oversized model omitted]',
              ),
            }
          : {}),
        ...(run.routing ? { routing: Object.freeze({ ...run.routing }) } : {}),
        ...(run.sessionId
          ? {
              sessionId: boundedTerminalField(
                run.sessionId,
                '[session omitted]',
              ),
            }
          : {}),
        ...(run.lineageId
          ? {
              lineageId: boundedTerminalField(
                run.lineageId,
                '[lineage omitted]',
              ),
            }
          : {}),
        ...(run.context ? { context: run.context } : {}),
        ...(run.allowWrites === undefined
          ? {}
          : { allowWrites: run.allowWrites }),
        ...(run.capabilities?.length
          ? { capabilities: Object.freeze([...run.capabilities]) }
          : {}),
        ...(run.isolation ? { isolation: run.isolation } : {}),
        ...(continuation &&
        Buffer.byteLength(continuation, 'utf8') <= MAX_WORKFLOW_TOKEN_BYTES
          ? { continuation }
          : {}),
        ...(worktree ? { worktree } : {}),
        ...(outputFile ? { outputFile } : {}),
        ...(compactLifecycle ? { lifecycle: compactLifecycle } : {}),
        ...(run.retryable ? { retryable: true } : {}),
        ...(run.queuedAt === undefined ? {} : { queuedAt: run.queuedAt }),
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        ...(run.workflowAttempt
          ? { workflowAttempt: Object.freeze({ ...run.workflowAttempt }) }
          : {}),
        ...(report ? { report } : {}),
      });
    }),
  );
  const reports = Object.freeze(
    runs.flatMap((run) => (run.report ? [run.report] : [])),
  );
  const rawTokens = sourceRuns
    .map((run) => run.continuation?.trim())
    .filter((token): token is string => Boolean(token));
  const oversizedToken = rawTokens.some(
    (token) => Buffer.byteLength(token, 'utf8') > MAX_WORKFLOW_TOKEN_BYTES,
  );
  const tokens = [...new Set(rawTokens)].filter(
    (token) => Buffer.byteLength(token, 'utf8') <= MAX_WORKFLOW_TOKEN_BYTES,
  );
  return Object.freeze({
    version: 1,
    reports,
    handoff: captureWorkflowText(result.handoff ?? ''),
    runs,
    ...(tokens.length === 1 ? { continuationToken: tokens[0] } : {}),
    continuationAmbiguous: tokens.length > 1,
    ...(oversizedToken ? { continuationUnavailable: true as const } : {}),
  });
}

/** Remove live report copies before writing an exact durable journal record. */
export function durableWorkflowResult(
  result: DelegateWorkflowResultRecord,
): DelegateWorkflowResultRecord {
  return Object.freeze({
    version: 1,
    reports: Object.freeze([]),
    handoff: Object.freeze({ ...result.handoff }),
    runs: Object.freeze(
      result.runs.map(({ report: _report, ...run }) => Object.freeze(run)),
    ),
    ...(result.continuationToken
      ? { continuationToken: result.continuationToken }
      : {}),
    continuationAmbiguous: result.continuationAmbiguous,
    ...(result.continuationUnavailable
      ? { continuationUnavailable: true as const }
      : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validEvidence(value: unknown): value is DelegateWorkflowTextEvidence {
  if (!isRecord(value) || !onlyKeys(value, ['text', 'bytes', 'oversized']))
    return false;
  if (
    typeof value.text !== 'string' ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    (value.oversized !== undefined && value.oversized !== true)
  )
    return false;
  const actual = Buffer.byteLength(value.text, 'utf8');
  return value.oversized === true
    ? value.text === WORKFLOW_OVERSIZED_EVIDENCE_MARKER &&
        value.bytes > WORKFLOW_INPUT_CAPS.perItemMaxBytes
    : value.bytes === actual && actual <= WORKFLOW_INPUT_CAPS.perItemMaxBytes;
}

function validCacheFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ['path', 'size']) &&
    typeof value.path === 'string' &&
    Buffer.byteLength(value.path, 'utf8') <= 4096 &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= 16 * 1024 * 1024
  );
}

const RUN_STATES = new Set([
  'queued',
  'running',
  'success',
  'error',
  'aborted',
  'timed-out',
]);

function validDurableRun(
  value: unknown,
): value is DelegateWorkflowRunProjection {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'runId',
      'name',
      'task',
      'exitCode',
      'state',
      'model',
      'routing',
      'sessionId',
      'lineageId',
      'context',
      'allowWrites',
      'capabilities',
      'isolation',
      'continuation',
      'worktree',
      'outputFile',
      'lifecycle',
      'retryable',
      'queuedAt',
      'startedAt',
      'finishedAt',
      'workflowAttempt',
    ]) ||
    typeof value.runId !== 'string' ||
    Buffer.byteLength(value.runId, 'utf8') >
      MAX_WORKFLOW_TERMINAL_FIELD_BYTES ||
    typeof value.name !== 'string' ||
    Buffer.byteLength(value.name, 'utf8') > MAX_WORKFLOW_TERMINAL_FIELD_BYTES ||
    typeof value.task !== 'string' ||
    Buffer.byteLength(value.task, 'utf8') > MAX_WORKFLOW_TERMINAL_FIELD_BYTES ||
    typeof value.exitCode !== 'number' ||
    !Number.isSafeInteger(value.exitCode) ||
    typeof value.state !== 'string' ||
    !RUN_STATES.has(value.state)
  )
    return false;
  for (const key of ['model', 'sessionId', 'lineageId'] as const)
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' ||
        Buffer.byteLength(value[key], 'utf8') >
          MAX_WORKFLOW_TERMINAL_FIELD_BYTES)
    )
      return false;
  if (
    value.context !== undefined &&
    !['branch', 'fresh', 'continuation'].includes(String(value.context))
  )
    return false;
  if (
    value.isolation !== undefined &&
    value.isolation !== 'shared' &&
    value.isolation !== 'worktree'
  )
    return false;
  if (value.allowWrites !== undefined && typeof value.allowWrites !== 'boolean')
    return false;
  if (value.retryable !== undefined && value.retryable !== true) return false;
  if (
    value.capabilities !== undefined &&
    (!Array.isArray(value.capabilities) ||
      value.capabilities.length > 1 ||
      value.capabilities.some((item) => item !== 'web'))
  )
    return false;
  if (
    value.continuation !== undefined &&
    (typeof value.continuation !== 'string' ||
      Buffer.byteLength(value.continuation, 'utf8') > MAX_WORKFLOW_TOKEN_BYTES)
  )
    return false;
  for (const key of ['queuedAt', 'startedAt', 'finishedAt'] as const)
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
    )
      return false;
  if (value.outputFile !== undefined && !validCacheFile(value.outputFile))
    return false;
  if (value.worktree !== undefined) {
    const worktree = value.worktree;
    if (
      !isRecord(worktree) ||
      !onlyKeys(worktree, [
        'id',
        'repositoryRoot',
        'worktreePath',
        'branch',
        'headCommit',
      ]) ||
      typeof worktree.id !== 'string' ||
      Buffer.byteLength(worktree.id, 'utf8') > 128 ||
      typeof worktree.repositoryRoot !== 'string' ||
      Buffer.byteLength(worktree.repositoryRoot, 'utf8') > 4096 ||
      typeof worktree.worktreePath !== 'string' ||
      Buffer.byteLength(worktree.worktreePath, 'utf8') > 4096 ||
      typeof worktree.branch !== 'string' ||
      Buffer.byteLength(worktree.branch, 'utf8') > 512 ||
      (worktree.headCommit !== undefined &&
        (typeof worktree.headCommit !== 'string' ||
          Buffer.byteLength(worktree.headCommit, 'utf8') > 128))
    )
      return false;
  }
  if (value.workflowAttempt !== undefined) {
    const attempt = value.workflowAttempt;
    if (
      !isRecord(attempt) ||
      !onlyKeys(attempt, ['logicalId', 'ordinal', 'identity']) ||
      typeof attempt.logicalId !== 'string' ||
      !isLogicalId(attempt.logicalId) ||
      typeof attempt.ordinal !== 'number' ||
      !Number.isSafeInteger(attempt.ordinal) ||
      attempt.ordinal < 1 ||
      attempt.ordinal > MAX_ATTEMPT_ORDINAL ||
      attempt.identity !== `${attempt.logicalId}@${attempt.ordinal}`
    )
      return false;
  }
  if (
    value.routing !== undefined &&
    (!isRecord(value.routing) ||
      Buffer.byteLength(JSON.stringify(value.routing), 'utf8') > 4096)
  )
    return false;
  if (
    value.lifecycle !== undefined &&
    (!isRecord(value.lifecycle) ||
      Buffer.byteLength(JSON.stringify(value.lifecycle), 'utf8') > 20 * 1024)
  )
    return false;
  return true;
}

/** Validate the exact compact result shape accepted at the journal boundary. */
export function isValidDurableWorkflowResult(
  value: unknown,
): value is DelegateWorkflowResultRecord {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'version',
      'reports',
      'handoff',
      'runs',
      'continuationToken',
      'continuationAmbiguous',
      'continuationUnavailable',
    ]) ||
    value.version !== 1 ||
    !Array.isArray(value.reports) ||
    value.reports.length !== 0 ||
    !validEvidence(value.handoff) ||
    !Array.isArray(value.runs) ||
    value.runs.length > MAX_WORKFLOW_RESULT_RUNS ||
    value.runs.some((run) => !validDurableRun(run)) ||
    typeof value.continuationAmbiguous !== 'boolean' ||
    (value.continuationUnavailable !== undefined &&
      value.continuationUnavailable !== true) ||
    (value.continuationToken !== undefined &&
      (typeof value.continuationToken !== 'string' ||
        Buffer.byteLength(value.continuationToken, 'utf8') >
          MAX_WORKFLOW_TOKEN_BYTES))
  )
    return false;
  return (
    Buffer.byteLength(JSON.stringify(value), 'utf8') <=
    MAX_WORKFLOW_RESULT_BYTES
  );
}
