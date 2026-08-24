import type { Message } from '@earendil-works/pi-ai';
import type { ArtifactMetadata } from '../shared/artifacts';
import {
  createOpaqueId,
  deriveCompatibilityLineageId,
  deriveCompatibilityRunId,
} from './identity';
import {
  normalizeWorkflowAttempt,
  type WorkflowAttempt,
} from './workflow-model';
import type { WorktreeBase, WorktreeSummary } from './worktree/model';

/** Harness-observed causes for a non-successful delegate settlement. */
export type DelegateLifecycleReason =
  | 'user-cancellation'
  | 'queued-cancellation'
  | 'timeout'
  | 'child-nonzero-exit'
  | 'provider-runner-error'
  | 'setup-failure'
  | 'lifecycle-cleanup-failure'
  | 'unknown';

/** One bounded, harness-authored recovery projection for failed runs. */
export interface DelegateLifecycleProjection {
  /** Stable code for what the harness actually observed, not a guess. */
  reason: DelegateLifecycleReason;
  /** Present only when the complete bounded diagnostic fits inline. */
  diagnostic?: string;
  /** Owner-session exact diagnostic when it does not fit inline. */
  diagnosticArtifact?: ArtifactMetadata;
  continuationUsable: boolean;
  writableBranchRetained: boolean;
  readOnlySnapshotRetained: boolean;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextTokens: number;
  cost: number;
  turns: number;
}

export interface DelegatedActivity {
  id?: string;
  type: 'thinking' | 'tool';
  label: string;
  status: 'running' | 'completed' | 'error';
  latestText?: string;
  /** Bounded complete thinking block; serialized into human-facing details. */
  transcriptText?: string;
  /** Bounded tool fields; serialized into human-facing details, not parent content. */
  toolName?: string;
  toolArguments?: unknown;
  toolResult?: unknown;
  toolArgumentsTruncated?: boolean;
  toolResultTruncated?: boolean;
  startedAt?: number;
}

export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface DelegateModelCatalogEntry {
  provider?: string;
  model: string;
  thinking: ThinkingLevel;
  relativeCost: number;
  /** Concrete task shapes this route handles. */
  useFor: string;
  /** Concrete task shapes to send elsewhere. */
  avoid: string;
}

export interface DelegateRouteState {
  route: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  relativeCost: number;
  warning?: string;
}

export type DelegateContext = 'branch' | 'fresh' | 'continuation';
/** Optional child tool bundles selected by the parent for a fresh lineage. */
export type DelegateChildCapability = 'web';
/** Whether a delegate shares the parent checkout or receives a worktree. */
export type DelegateIsolation = 'shared' | 'worktree';
export type DelegateInputEvidenceKind =
  | 'report'
  | 'handoff'
  | 'branch'
  | 'metadata';
/** Small, bounded public evidence projection for selected-run inspection. */
export interface DelegateInputEvidence {
  identity: string;
  kind: DelegateInputEvidenceKind;
  label: string;
  content?: string;
  branch?: {
    branch?: string;
    worktreePath?: string;
    base?: string;
    headCommit?: string;
  };
}
export type DelegateRunState =
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'aborted'
  | 'timed-out';

export type DelegateProgressUpdate = Parameters<
  NonNullable<
    Parameters<
      typeof import('./task-lifecycle').runPreparedDelegateTask
    >[1]['onUpdate']
  >
>[0];

export type DelegateCheckpointState =
  | 'requested'
  | 'acknowledged'
  | 'unavailable'
  | 'hard-timeout';

export interface DelegateCheckpoint {
  requestedAt: number;
  acknowledgedAt?: number;
  state: DelegateCheckpointState;
}

export interface DelegateRunMetadata {
  /** Stable identity for this invocation; generated for every new run. */
  runId?: string;
  /** Session-scoped immutable workflow identity, when supplied. */
  workflowAttempt?: WorkflowAttempt;
  /** Canonical Pi child session used by dashboard session APIs. */
  sessionId?: string;
  /** Stable child-session lineage, when preparation has a delegate session. */
  lineageId?: string;
  name?: string;
  cwd?: string;
  context?: DelegateContext;
  contextNote?: string;
  allowWrites?: boolean;
  writeRequested?: boolean;
  /** Effective optional tool bundles inherited by continuations. */
  capabilities?: DelegateChildCapability[];
  /** Effective workspace isolation, independent from write capability. */
  isolation?: DelegateIsolation;
  scope?: string[];
  continuation?: string;
  backgroundJobId?: string;
  warnings?: string[];
  /** The branch holding this run's work, when it ran in its own worktree. */
  worktree?: WorktreeSummary;
  /** Bounded resolved workflow evidence retained for selected-run inspection. */
  inputEvidence?: readonly DelegateInputEvidence[];
  /** Requested refresh source; continuations may change this only for read-only runs. */
  refreshSource?: WorktreeBase;
  /** Exact final prompt sent to the child, retained within bounded public details. */
  renderedPrompt?: string;
  /** Exact final assistant output, stored only when the parent handoff omits it. */
  artifact?: ArtifactMetadata;
  /** A bounded pre-timeout checkpoint request and its observed outcome. */
  checkpoint?: DelegateCheckpoint;
  /** The host transport failed transiently; a later observation may retry. */
  retryable?: boolean;
  /** Public projection; authored by the harness and ignored from child input. */
  lifecycle?: DelegateLifecycleProjection;
}

export interface DelegatedRun extends DelegateRunMetadata {
  runId: string;
  name: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  routing?: DelegateRouteState;
  activities: DelegatedActivity[];
  /** Canonical lifecycle state for every current/internal run. */
  state: DelegateRunState;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
}

/** A branch descriptor retained for a later verified symbolic branch import. */
export interface DelegateWorkflowBranchDescriptor {
  readonly id: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly headCommit?: string;
}

/** Exact text retained by a workflow source, or a non-clipping overflow marker. */
export interface DelegateWorkflowTextEvidence {
  readonly text: string;
  readonly bytes: number;
  readonly oversized?: true;
}

/** Minimal terminal run projection used by workflow status and symbolic inputs. */
export interface DelegateWorkflowRunProjection {
  readonly runId: string;
  readonly name: string;
  readonly task: string;
  readonly exitCode: number;
  readonly state: DelegateRunState;
  readonly model?: string;
  readonly routing?: DelegateRouteState;
  /** Bounded identifiers for terminal status, never child session objects. */
  readonly sessionId?: string;
  readonly lineageId?: string;
  readonly context?: DelegateContext;
  readonly allowWrites?: boolean;
  readonly capabilities?: readonly DelegateChildCapability[];
  readonly isolation?: DelegateIsolation;
  readonly continuation?: string;
  readonly worktree?: DelegateWorkflowBranchDescriptor;
  readonly artifact?: ArtifactMetadata;
  readonly lifecycle?: DelegateLifecycleProjection;
  readonly retryable?: boolean;
  readonly queuedAt?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly workflowAttempt?: WorkflowAttempt;
  /** Internal exact report evidence; omitted from public terminal projections. */
  readonly report?: DelegateWorkflowTextEvidence;
}

/**
 * Bounded canonical evidence for one settled workflow attempt. This is not a
 * child execution result: messages, stderr, activities, sessions, and the
 * DelegateJobResult envelope never cross this boundary.
 */
export interface DelegateWorkflowResultRecord {
  readonly version: 1;
  readonly reports: readonly DelegateWorkflowTextEvidence[];
  readonly handoff: DelegateWorkflowTextEvidence;
  readonly runs: readonly DelegateWorkflowRunProjection[];
  readonly continuationToken?: string;
  readonly continuationAmbiguous: boolean;
  readonly continuationUnavailable?: true;
}

/** Public status/result projection returned by the coordinator API. */
export interface DelegateWorkflowResultProjection {
  readonly runs: readonly DelegatedRun[];
  readonly handoff: string;
}

export interface DelegateDetails {
  mode: 'single' | 'parallel';
  runs: DelegatedRun[];
}

/**
 * Tool details written before lifecycle state became canonical. Keep this
 * shape at the loading/rendering boundary only; current code uses
 * DelegatedRun with a required state.
 */
export type LegacyDelegatedRun = Omit<DelegatedRun, 'state' | 'runId'> & {
  /** Added at the trusted persisted-details boundary for old tool records. */
  runId?: string;
  state?: DelegateRunState;
};

export type LegacyDelegateDetails = Omit<DelegateDetails, 'runs'> & {
  runs: LegacyDelegatedRun[];
};

export function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextTokens: 0,
    cost: 0,
    turns: 0,
  };
}

export function createRun(
  task: string,
  routing?: DelegateRouteState,
  metadata: DelegateRunMetadata = {},
): DelegatedRun {
  const workflowAttempt =
    metadata.workflowAttempt === undefined
      ? undefined
      : normalizeWorkflowAttempt(metadata.workflowAttempt);
  return {
    task,
    exitCode: -1,
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    routing,
    activities: [],
    state: 'queued',
    queuedAt: Date.now(),
    ...metadata,
    ...(workflowAttempt ? { workflowAttempt } : {}),
    runId: metadata.runId ?? createOpaqueId(),
    name: metadata.name?.trim() || 'Subagent',
  };
}

/** Return the canonical state; diagnostics never replace it. */
export function getRunState(run: DelegatedRun): DelegateRunState {
  return run.state;
}

export function isRunError(run: DelegatedRun): boolean {
  return (
    run.state === 'error' ||
    run.state === 'aborted' ||
    run.state === 'timed-out'
  );
}

function inferLegacyRunState(run: LegacyDelegatedRun): DelegateRunState {
  if (run.state) return run.state;
  if (run.exitCode === -1) return 'running';
  if (run.stopReason === 'aborted') return 'aborted';
  if (run.exitCode === 124) return 'timed-out';
  if (
    run.stopReason === 'error' ||
    run.stopReason === 'aborted' ||
    run.exitCode !== 0 ||
    !getFinalAssistantText(run.messages).trim()
  )
    return 'error';
  return 'success';
}

/** Normalize old persisted tool details before they enter current code. */
export function normalizeDelegateRun(run: LegacyDelegatedRun): DelegatedRun {
  const runId = run.runId ?? deriveCompatibilityRunId(run);
  const lineageId =
    run.lineageId ??
    (run.continuation
      ? deriveCompatibilityLineageId(run.continuation)
      : undefined);
  const workflowAttempt =
    run.workflowAttempt === undefined
      ? undefined
      : normalizeWorkflowAttempt(run.workflowAttempt);
  return run.state &&
    run.runId &&
    (run.lineageId || !run.continuation) &&
    workflowAttempt === undefined
    ? (run as DelegatedRun)
    : {
        ...run,
        runId,
        ...(lineageId ? { lineageId } : {}),
        ...(workflowAttempt ? { workflowAttempt } : {}),
        state: run.state ?? inferLegacyRunState(run),
      };
}

export function normalizeDelegateDetails(
  details: LegacyDelegateDetails,
): DelegateDetails {
  if (
    details.runs.every(
      (run) => run.state && run.runId && run.workflowAttempt === undefined,
    )
  )
    return details as DelegateDetails;
  return {
    ...details,
    runs: details.runs.map(normalizeDelegateRun),
  };
}

/**
 * A worktree records a prior terminal run so its partial branch remains
 * reviewable. A successful continuation is a new attempt, not that failure.
 */
export function continuationRecoveryNote(
  run: DelegatedRun,
): string | undefined {
  if (
    run.context !== 'continuation' ||
    getRunState(run) !== 'success' ||
    !run.worktree
  )
    return undefined;

  const outcome = run.worktree.runOutcome;
  if (outcome === 'timed-out')
    return 'Earlier attempt timed out; this continuation completed on the same branch.';
  if (outcome === 'aborted')
    return 'Earlier attempt was aborted; this continuation completed on the same branch.';
  if (outcome === 'error')
    return 'Earlier attempt ended with error; this continuation completed on the same branch.';

  // Records written before runOutcome existed retain only this exact prose.
  const error = run.worktree.error;
  if (!error) return undefined;
  if (/^The delegate run timed out;/.test(error))
    return 'Earlier attempt timed out; this continuation completed on the same branch.';
  if (/^The delegate run ended with aborted;/.test(error))
    return 'Earlier attempt was aborted; this continuation completed on the same branch.';
  if (/^The delegate run ended with error;/.test(error))
    return 'Earlier attempt ended with error; this continuation completed on the same branch.';
  return undefined;
}

export function getFinalAssistantText(
  messages: Message[],
  options?: { exact?: boolean },
): string {
  const exact = options?.exact ?? false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text' && (exact || part.text.trim()))
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    if (exact) {
      if (text.trim()) return text;
    } else if (text.trim()) {
      return text.trim();
    }
  }
  return '';
}

export function getExactFinalAssistantText(messages: Message[]): string {
  return getFinalAssistantText(messages, { exact: true });
}
