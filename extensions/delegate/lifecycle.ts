import { BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES } from '@pi-agent/background-jobs';
import type { CacheFile } from '../shared/cache-files';
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
/** Marker used when an exact capture cannot be written to a cache file. */
export const LIFECYCLE_PUBLIC_FALLBACK_MARKER =
  '\n[Exact lifecycle diagnostic file unavailable; bounded fallback shown.]';
/** Stderr is evidence for a child-exit diagnostic, never a public raw stream. */
export const LIFECYCLE_STDERR_BYTES = 8 * 1024;

interface LifecycleRecord {
  reason: DelegateLifecycleReason;
  diagnostic?: string;
  diagnosticFile?: CacheFile;
  diagnosticPublicationFailed?: boolean;
  eventOverflow?: DelegateLifecycleProjection['eventOverflow'];
}

const records = new WeakMap<DelegatedRun, LifecycleRecord>();
const eventOverflows = new WeakMap<
  DelegatedRun,
  {
    eventCount: number;
    totalBytes: number;
    capturedEvents: number;
    capturedBytes: number;
    unavailableEvents: number;
    unavailableReason?: NonNullable<
      DelegateLifecycleProjection['eventOverflow']
    >['unavailableReason'];
    lines: Buffer[];
    artifactFile?: CacheFile;
    artifactPublicationFailed?: boolean;
  }
>();
const TRUSTED_LIFECYCLE = Symbol('trusted delegate lifecycle projection');
const LIFECYCLE_REASONS: readonly DelegateLifecycleReason[] = [
  'user-cancellation',
  'queued-cancellation',
  'timeout',
  'child-nonzero-exit',
  'event-overflow',
  'provider-runner-error',
  'setup-failure',
  'lifecycle-cleanup-failure',
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

function byteBoundedWithMarker(
  value: string,
  maxBytes: number,
  marker: string,
): string {
  if (byteLength(value) <= maxBytes) return value;
  const markerBytes = byteLength(marker);
  if (maxBytes <= markerBytes) {
    let result = marker;
    while (result && byteLength(result) > maxBytes)
      result = result.slice(0, -1);
    return result;
  }
  const contentBudget = maxBytes - markerBytes;
  let result = value.slice(0, contentBudget);
  while (result && byteLength(result) > contentBudget)
    result = result.slice(0, -1);
  return result + marker;
}

/** Keep publication-failure diagnostics actionable without exposing full captures. */
export function boundLifecyclePublicFallback(
  value: string,
  maxBytes = LIFECYCLE_INLINE_DIAGNOSTIC_BYTES,
): string {
  return byteBoundedWithMarker(
    value,
    maxBytes,
    LIFECYCLE_PUBLIC_FALLBACK_MARKER,
  );
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
      case 'event-overflow':
        return 'The child emitted truncated events that could not be validated.';
      case 'provider-runner-error':
        return 'The delegate runner failed before it could settle the child.';
      case 'setup-failure':
        return 'Delegate setup failed before the child launched.';
      case 'lifecycle-cleanup-failure':
        return 'The delegate finished, but lifecycle cleanup failed.';
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
  const eventOverflow = value.eventOverflow;
  if (
    eventOverflow !== undefined &&
    (!eventOverflow ||
      !Number.isSafeInteger(eventOverflow.eventCount) ||
      eventOverflow.eventCount < 1 ||
      !Number.isSafeInteger(eventOverflow.totalBytes) ||
      eventOverflow.totalBytes < 0 ||
      !Number.isSafeInteger(eventOverflow.capturedEvents) ||
      eventOverflow.capturedEvents < 0 ||
      !Number.isSafeInteger(eventOverflow.capturedBytes) ||
      eventOverflow.capturedBytes < 0 ||
      !Number.isSafeInteger(eventOverflow.unavailableEvents) ||
      eventOverflow.unavailableEvents < 0 ||
      (eventOverflow.artifactFile !== undefined &&
        (typeof eventOverflow.artifactFile.path !== 'string' ||
          !Number.isSafeInteger(eventOverflow.artifactFile.size) ||
          eventOverflow.artifactFile.size < 0)))
  )
    return false;
  const record: LifecycleRecord = {
    reason: value.reason,
    ...(value.diagnostic !== undefined ? { diagnostic: value.diagnostic } : {}),
    ...(value.diagnosticFile ? { diagnosticFile: value.diagnosticFile } : {}),
    ...(eventOverflow ? { eventOverflow } : {}),
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

export function setDelegateLifecycleDiagnosticFile(
  run: DelegatedRun,
  file: CacheFile | undefined,
): void {
  const record = records.get(run);
  if (!record) return;
  if (file) record.diagnosticFile = file;
  else delete record.diagnosticFile;
}

export function recordDelegateEventOverflow(
  run: DelegatedRun,
  bytes: number,
  content?: Uint8Array,
  unavailableReason?: NonNullable<
    DelegateLifecycleProjection['eventOverflow']
  >['unavailableReason'],
): void {
  let overflow = eventOverflows.get(run);
  if (!overflow) {
    overflow = {
      eventCount: 0,
      totalBytes: 0,
      capturedEvents: 0,
      capturedBytes: 0,
      unavailableEvents: 0,
      lines: [],
    };
    eventOverflows.set(run, overflow);
  }
  overflow.eventCount++;
  overflow.totalBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    overflow.totalBytes +
      (Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0),
  );
  const separatorBytes = overflow.capturedEvents;
  if (
    content &&
    content.byteLength === bytes &&
    overflow.capturedBytes + content.byteLength + separatorBytes <=
      BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES
  ) {
    const exact = Buffer.from(content);
    overflow.lines.push(exact);
    overflow.capturedEvents++;
    overflow.capturedBytes += exact.byteLength;
  } else {
    overflow.unavailableEvents++;
    overflow.unavailableReason ??= unavailableReason ?? 'capture-limit';
  }
}

export function hasDelegateEventOverflow(run: DelegatedRun): boolean {
  return (eventOverflows.get(run)?.eventCount ?? 0) > 0;
}

export async function publishDelegateEventOverflow(
  run: DelegatedRun,
  write: (bytes: Uint8Array, extension: string) => Promise<CacheFile>,
): Promise<void> {
  const overflow = eventOverflows.get(run);
  if (!overflow || overflow.capturedEvents === 0 || overflow.artifactFile)
    return;
  const parts: Buffer[] = [];
  overflow.lines.forEach((event, index) => {
    if (index > 0) parts.push(Buffer.from('\n'));
    parts.push(event);
  });
  try {
    overflow.artifactFile = await write(Buffer.concat(parts), '.jsonl');
  } catch {
    overflow.artifactPublicationFailed = true;
  }
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

function copyEventOverflow(
  overflow: NonNullable<DelegateLifecycleProjection['eventOverflow']>,
  includeFile: boolean,
): NonNullable<DelegateLifecycleProjection['eventOverflow']> {
  const { artifactFile, ...metadata } = overflow;
  return {
    ...metadata,
    ...(includeFile && artifactFile
      ? { artifactFile: { ...artifactFile } }
      : {}),
  };
}

export function getDelegateLifecycle(
  run: DelegatedRun,
  options: {
    includeFile?: boolean;
    /** Include a <=2 KiB fallback when the exact capture cannot cross this path. */
    includeBoundedFallback?: boolean;
  } = {},
): DelegateLifecycleProjection | undefined {
  const record = records.get(run);
  if (!record) return undefined;
  const facts = resourceFacts(run);
  const inline =
    record.diagnostic &&
    (byteLength(record.diagnostic) <= LIFECYCLE_INLINE_DIAGNOSTIC_BYTES
      ? record.diagnostic
      : options.includeBoundedFallback === true ||
          record.diagnosticPublicationFailed
        ? boundLifecyclePublicFallback(record.diagnostic)
        : undefined);
  const overflow = eventOverflows.get(run);
  const storedOverflow = overflow
    ? {
        eventCount: overflow.eventCount,
        totalBytes: overflow.totalBytes,
        capturedEvents: overflow.capturedEvents,
        capturedBytes: overflow.capturedBytes,
        unavailableEvents: overflow.unavailableEvents,
        ...(overflow.unavailableReason
          ? { unavailableReason: overflow.unavailableReason }
          : {}),
        ...(overflow.artifactPublicationFailed
          ? { artifactPublicationFailed: true }
          : {}),
        ...(options.includeFile === false
          ? {}
          : overflow.artifactFile
            ? { artifactFile: { ...overflow.artifactFile } }
            : {}),
      }
    : record.eventOverflow;
  const eventOverflow = storedOverflow
    ? copyEventOverflow(storedOverflow, options.includeFile !== false)
    : undefined;
  return {
    reason: record.reason,
    ...(inline ? { diagnostic: inline } : {}),
    ...(options.includeFile === false
      ? {}
      : record.diagnosticFile
        ? { diagnosticFile: record.diagnosticFile }
        : {}),
    ...(eventOverflow ? { eventOverflow } : {}),
    ...facts,
  };
}

/** Copy a public projection without retaining a mutable caller-owned object. */
export function cloneDelegateLifecycle(
  projection: DelegateLifecycleProjection | undefined,
  options: { includeFile?: boolean } = {},
): DelegateLifecycleProjection | undefined {
  if (!projection) return undefined;
  return {
    reason: projection.reason,
    ...(projection.diagnostic !== undefined
      ? { diagnostic: projection.diagnostic }
      : {}),
    ...(options.includeFile === false
      ? {}
      : projection.diagnosticFile
        ? { diagnosticFile: { ...projection.diagnosticFile } }
        : {}),
    ...(projection.eventOverflow
      ? {
          eventOverflow: copyEventOverflow(
            projection.eventOverflow,
            options.includeFile !== false,
          ),
        }
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
  options: { includeFile?: boolean } = {},
): void {
  const record = records.get(source);
  if (!record) return;
  const eventOverflow = getDelegateLifecycle(source, {
    includeFile: options.includeFile,
  })?.eventOverflow;
  records.set(target, {
    reason: record.reason,
    ...(record.diagnostic !== undefined
      ? { diagnostic: record.diagnostic }
      : {}),
    ...(options.includeFile === false
      ? {}
      : record.diagnosticFile
        ? { diagnosticFile: { ...record.diagnosticFile } }
        : {}),
    ...(eventOverflow ? { eventOverflow } : {}),
    ...(record.diagnosticPublicationFailed
      ? { diagnosticPublicationFailed: true }
      : {}),
  });
  Object.defineProperty(target, TRUSTED_LIFECYCLE, {
    value: true,
    configurable: true,
  });
}
