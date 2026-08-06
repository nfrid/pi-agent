import type { ArtifactMetadata } from '../shared/artifacts';
import { resolveDelegateSession } from './session';
import {
  type DelegatedRun,
  type DelegateLifecycleProjection,
  type DelegateLifecycleReason,
  getRunState,
} from './types';
import { loadWorktree } from './worktree';

/** Maximum diagnostic capture retained by the harness for one failed run. */
export const LIFECYCLE_DIAGNOSTIC_CAPTURE_BYTES = 64 * 1024;
/** Maximum diagnostic bytes copied into the parent envelope. */
export const LIFECYCLE_INLINE_DIAGNOSTIC_BYTES = 2 * 1024;
/** Stderr is evidence for a child-exit diagnostic, never a public raw stream. */
export const LIFECYCLE_STDERR_BYTES = 8 * 1024;

interface LifecycleRecord {
  reason: DelegateLifecycleReason;
  /** Undefined when a persisted projection retained only its artifact handle. */
  diagnostic?: string;
  diagnosticArtifact?: ArtifactMetadata;
  diagnosticPublicationFailed?: boolean;
}

const records = new WeakMap<DelegatedRun, LifecycleRecord>();
const TRUSTED_LIFECYCLE = Symbol('trusted delegate lifecycle projection');
const LIFECYCLE_REASONS: readonly DelegateLifecycleReason[] = [
  'user-cancellation',
  'queued-cancellation',
  'timeout',
  'child-nonzero-exit',
  'provider-runner-error',
  'setup-failure',
  'lifecycle-cleanup-failure',
  'child-result-invalid',
  'unknown',
];

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** UTF-8-safe bounded text capture. The returned value is the exact capture. */
export function boundLifecycleText(
  value: unknown,
  maxBytes = LIFECYCLE_DIAGNOSTIC_CAPTURE_BYTES,
): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (byteLength(text) <= maxBytes) return text;
  const marker = '\n[Diagnostic capture bounded by the delegate harness.]';
  const markerBytes = byteLength(marker);
  if (maxBytes <= markerBytes) {
    let result = marker;
    while (result && byteLength(result) > maxBytes)
      result = result.slice(0, -1);
    return result;
  }
  let result = text.slice(0, Math.max(0, maxBytes - markerBytes));
  while (result && byteLength(result) > maxBytes - markerBytes)
    result = result.slice(0, -1);
  return result + marker;
}

function stderrDiagnostic(stderr: string): string {
  if (!stderr.trim()) return '';
  const bounded = boundLifecycleText(stderr, LIFECYCLE_STDERR_BYTES);
  return `\nBounded child diagnostic:\n${bounded}`;
}

/** Build one actionable diagnostic without publishing an unbounded stderr stream. */
export function buildLifecycleDiagnostic(
  reason: DelegateLifecycleReason,
  primary?: unknown,
  stderr?: string,
): string {
  const detail = boundLifecycleText(primary);
  const suffix =
    reason === 'child-nonzero-exit' || reason === 'unknown'
      ? stderrDiagnostic(stderr ?? '')
      : '';
  const fallback = (() => {
    switch (reason) {
      case 'user-cancellation':
        return 'The parent cancelled the delegate while it was running.';
      case 'queued-cancellation':
        return 'The delegate was cancelled before it acquired a launch slot.';
      case 'timeout':
        return 'The delegate exceeded its configured runtime limit.';
      case 'child-nonzero-exit':
        return 'The child process exited unsuccessfully.';
      case 'provider-runner-error':
        return 'The delegate runner failed before it could settle the child.';
      case 'setup-failure':
        return 'Delegate setup failed before the child launched.';
      case 'lifecycle-cleanup-failure':
        return 'The delegate finished, but lifecycle cleanup failed.';
      case 'child-result-invalid':
        return 'The child did not return a valid structured result.';
      case 'unknown':
        return 'The harness could not determine why the delegate did not settle successfully.';
    }
  })();
  return boundLifecycleText(`${detail || fallback}${suffix}`);
}

function resourceFacts(
  run: DelegatedRun,
): Pick<
  DelegateLifecycleProjection,
  'continuationUsable' | 'writableBranchRetained' | 'readOnlySnapshotRetained'
> {
  const session = run.continuation
    ? resolveDelegateSession(run.continuation)
    : null;
  // A resumed setup can fail before the run receives a worktree summary. The
  // durable continuation metadata is still authoritative for recovery facts.
  const worktreeId = run.worktree?.id ?? session?.worktreeId;
  const record = worktreeId ? loadWorktree(worktreeId) : undefined;
  const retained = Boolean(
    record && record.status !== 'removed' && Boolean(record.branch),
  );
  const allowWrites = run.allowWrites ?? session?.allowWrites;
  const continuationUsable = Boolean(
    session && (!session.worktreeId || retained),
  );
  return {
    continuationUsable,
    writableBranchRetained: Boolean(
      retained && allowWrites === true && !record?.snapshot,
    ),
    // A failed read-only run keeps its checkout for diagnosis; a clean one
    // retires that checkout as a resumable snapshot. Both are read-only
    // recovery resources until the record is removed.
    readOnlySnapshotRetained: Boolean(retained && allowWrites !== true),
  };
}

export function setDelegateLifecycleText(
  run: DelegatedRun,
  reason: DelegateLifecycleReason,
  diagnostic: string,
): void {
  records.set(run, {
    reason,
    diagnostic: boundLifecycleText(diagnostic),
  });
  Object.defineProperty(run, TRUSTED_LIFECYCLE, {
    value: true,
    configurable: true,
  });
}

function isLifecycleReason(value: unknown): value is DelegateLifecycleReason {
  return (
    typeof value === 'string' &&
    LIFECYCLE_REASONS.includes(value as DelegateLifecycleReason)
  );
}

/**
 * Rehydrate a projection that crossed a trusted persistence boundary.
 *
 * This is intentionally not part of ensureDelegateLifecycle: arbitrary child
 * input may contain a lifecycle-shaped field and must never be allowed to
 * author harness state. Callers use this only for details/job snapshots that
 * were already produced by the harness.
 */
export function hydrateDelegateLifecycle(
  run: DelegatedRun,
  projection: unknown,
): boolean {
  if (!projection || typeof projection !== 'object') return false;
  const value = projection as Partial<DelegateLifecycleProjection>;
  if (
    !isLifecycleReason(value.reason) ||
    typeof value.continuationUsable !== 'boolean' ||
    typeof value.writableBranchRetained !== 'boolean' ||
    typeof value.readOnlySnapshotRetained !== 'boolean'
  )
    return false;
  if (
    value.diagnostic !== undefined &&
    (typeof value.diagnostic !== 'string' ||
      byteLength(value.diagnostic) > LIFECYCLE_DIAGNOSTIC_CAPTURE_BYTES)
  )
    return false;
  const record: LifecycleRecord = {
    reason: value.reason,
    ...(value.diagnostic !== undefined ? { diagnostic: value.diagnostic } : {}),
    ...(value.diagnosticArtifact
      ? { diagnosticArtifact: value.diagnosticArtifact }
      : {}),
  };
  records.set(run, record);
  Object.defineProperty(run, TRUSTED_LIFECYCLE, {
    value: true,
    configurable: true,
  });
  return true;
}

/** Whether this run was produced by a harness serialization boundary. */
export function hasTrustedDelegateLifecycle(run: DelegatedRun): boolean {
  return (
    (run as DelegatedRun & { [TRUSTED_LIFECYCLE]?: boolean })[
      TRUSTED_LIFECYCLE
    ] === true
  );
}

export function setDelegateLifecycle(
  run: DelegatedRun,
  reason: DelegateLifecycleReason,
  diagnostic: unknown,
): void {
  setDelegateLifecycleText(
    run,
    reason,
    buildLifecycleDiagnostic(reason, diagnostic),
  );
}

export function getDelegateLifecycleDiagnostic(
  run: DelegatedRun,
): string | undefined {
  return records.get(run)?.diagnostic;
}

export function isDelegateLifecycleDiagnosticPublicationFailed(
  run: DelegatedRun,
): boolean {
  return records.get(run)?.diagnosticPublicationFailed === true;
}

export function markDelegateLifecycleDiagnosticPublicationFailed(
  run: DelegatedRun,
): void {
  const record = records.get(run);
  if (record) record.diagnosticPublicationFailed = true;
}

export function setDelegateLifecycleDiagnosticArtifact(
  run: DelegatedRun,
  artifact: ArtifactMetadata | undefined,
): void {
  const record = records.get(run);
  if (!record) return;
  if (artifact) record.diagnosticArtifact = artifact;
  else delete record.diagnosticArtifact;
}

/** Ensure old persisted error details receive a truthful, conservative code. */
export function ensureDelegateLifecycle(
  run: DelegatedRun,
): DelegateLifecycleProjection | undefined {
  if (!['error', 'aborted', 'timed-out'].includes(getRunState(run)))
    return undefined;
  if (!records.has(run))
    setDelegateLifecycle(
      run,
      'unknown',
      run.errorMessage || 'No harness lifecycle cause was retained.',
    );
  return getDelegateLifecycle(run);
}

export function getDelegateLifecycle(
  run: DelegatedRun,
  options: {
    includeArtifact?: boolean;
    /** Used only by stale-session projections after owner handles are removed. */
    forceInlineDiagnostic?: boolean;
  } = {},
): DelegateLifecycleProjection | undefined {
  const record = records.get(run);
  if (!record) return undefined;
  const facts = resourceFacts(run);
  const inline =
    record.diagnostic &&
    (options.forceInlineDiagnostic === true ||
      byteLength(record.diagnostic) <= LIFECYCLE_INLINE_DIAGNOSTIC_BYTES ||
      record.diagnosticPublicationFailed)
      ? record.diagnostic
      : undefined;
  return {
    reason: record.reason,
    ...(inline ? { diagnostic: inline } : {}),
    ...(options.includeArtifact === false
      ? {}
      : record.diagnosticArtifact
        ? { diagnosticArtifact: record.diagnosticArtifact }
        : {}),
    ...facts,
  };
}

/** Copy a public projection without retaining a mutable caller-owned object. */
export function cloneDelegateLifecycle(
  projection: DelegateLifecycleProjection | undefined,
  options: { includeArtifact?: boolean } = {},
): DelegateLifecycleProjection | undefined {
  if (!projection) return undefined;
  return {
    reason: projection.reason,
    ...(projection.diagnostic !== undefined
      ? { diagnostic: projection.diagnostic }
      : {}),
    ...(options.includeArtifact === false
      ? {}
      : projection.diagnosticArtifact
        ? { diagnosticArtifact: { ...projection.diagnosticArtifact } }
        : {}),
    continuationUsable: projection.continuationUsable,
    writableBranchRetained: projection.writableBranchRetained,
    readOnlySnapshotRetained: projection.readOnlySnapshotRetained,
  };
}

/** Copy only harness-owned lifecycle state when session-bound sanitization clones a run. */
export function copyDelegateLifecycle(
  source: DelegatedRun,
  target: DelegatedRun,
  options: { includeArtifact?: boolean } = {},
): void {
  const record = records.get(source);
  if (!record) return;
  records.set(target, {
    reason: record.reason,
    ...(record.diagnostic !== undefined
      ? { diagnostic: record.diagnostic }
      : {}),
    ...(options.includeArtifact === false
      ? {}
      : record.diagnosticArtifact
        ? { diagnosticArtifact: { ...record.diagnosticArtifact } }
        : {}),
    ...(record.diagnosticPublicationFailed
      ? { diagnosticPublicationFailed: true }
      : {}),
  });
  Object.defineProperty(target, TRUSTED_LIFECYCLE, {
    value: true,
    configurable: true,
  });
}
