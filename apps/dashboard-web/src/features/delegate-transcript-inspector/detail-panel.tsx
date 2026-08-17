import type { DelegateHistoryRunDetailResponse } from '@pi-dashboard/protocol';
import type { DelegateStatus } from '../../../../../extensions/delegate/contribution';
import type { DelegateInspectionStatus } from '../delegate/history-compose';
import {
  surfaceElapsed,
  surfaceStateClass,
  surfaceStateLabel,
} from '../delegate/surface-state';

export function DelegateInspectorMetadata({
  row,
  now,
}: {
  row: DelegateInspectionStatus;
  now: number;
}) {
  const state = surfaceStateLabel(
    row.pauseState ?? row.workflow?.state ?? row.state,
  );
  const duration = surfaceElapsed(
    row.workflow?.startedAt ?? row.startedAt ?? row.createdAt,
    row.workflow?.settledAt ?? row.finishedAt,
    row.pausedAt ?? now,
  );
  const lifecycle = row.lifecycle;
  return (
    <fieldset
      className="delegate-inspector-metadata"
      aria-label="Delegate details"
    >
      <span className={surfaceStateClass(state)}>{state}</span>
      {duration && <span>{duration}</span>}
      {row.runCount && row.runCount > 1 && <span>{row.runCount} attempts</span>}
      {lifecycle && (
        <>
          <span>recovery {lifecycle.reason}</span>
          <span>
            continuation{' '}
            {lifecycle.continuationUsable ? 'ready' : 'unavailable'}
          </span>
          <span>
            {lifecycle.writableBranchRetained
              ? 'writable branch retained'
              : lifecycle.readOnlySnapshotRetained
                ? 'read-only snapshot retained'
                : 'no recovery checkout'}
          </span>
          {lifecycle.diagnostic && <span>diagnostic available</span>}
          {lifecycle.diagnosticArtifact && (
            <span>diagnostic artifact available</span>
          )}
        </>
      )}
    </fieldset>
  );
}

function artifactHandle(row: DelegateStatus): string | undefined {
  const artifact = row.lifecycle?.diagnosticArtifact;
  return artifact &&
    typeof artifact === 'object' &&
    typeof (artifact as { handle?: unknown }).handle === 'string'
    ? (artifact as { handle: string }).handle
    : undefined;
}

export function DelegateInspectorDetails({
  row,
  now,
}: {
  row: DelegateInspectionStatus;
  now: number;
}) {
  const lifecycle = row.lifecycle;
  const runs = row.runs ?? [];
  const warnings = row.warnings ?? [];
  const runKeyOccurrences = new Map<string, number>();
  const handle = artifactHandle(row);
  const inputIdentities = new Set(
    (row.workflow?.inputs ?? []).map((input) => input.identity),
  );
  const after = (row.workflow?.dependencies ?? []).filter(
    (dependency) => !inputIdentities.has(dependency),
  );
  return (
    <details className="delegate-inspector-details">
      <summary>Run and recovery details</summary>
      <dl>
        {after.length > 0 ? (
          <div>
            <dt>After</dt>
            <dd>{after.join(', ')}</dd>
          </div>
        ) : null}
        {row.workflow?.inputs?.map((input) => (
          <div key={`${input.identity}:${input.node}`}>
            <dt>Inputs</dt>
            <dd>
              {input.identity} ·{' '}
              {(input.include?.length ? input.include : ['report']).join(' + ')}
              {input.label ? ` · ${input.label}` : ''}
            </dd>
          </div>
        ))}
        {row.jobId && (
          <div>
            <dt>Job</dt>
            <dd>{row.jobId}</dd>
          </div>
        )}
        <div>
          <dt>Access</dt>
          <dd>{row.allowWrites ? 'read/write' : 'read-only'}</dd>
        </div>
        {row.context && (
          <div>
            <dt>Context</dt>
            <dd>{row.context}</dd>
          </div>
        )}
        {(row.route ?? row.workflow?.route) && (
          <div>
            <dt>Route</dt>
            <dd>{row.route ?? row.workflow?.route}</dd>
          </div>
        )}
      </dl>
      {warnings.length > 0 && (
        <div className="delegate-inspector-warnings">
          <strong>Warnings</strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {runs.length > 0 && (
        <ol className="delegate-inspector-runs" aria-label="Run history">
          {runs.map((run, index) => {
            const duration = surfaceElapsed(
              run.startedAt,
              run.finishedAt,
              row.pausedAt ?? now,
            );
            const baseKey = `${run.state}:${run.startedAt ?? ''}:${run.finishedAt ?? ''}`;
            const occurrence = (runKeyOccurrences.get(baseKey) ?? 0) + 1;
            runKeyOccurrences.set(baseKey, occurrence);
            const key = occurrence === 1 ? baseKey : `${baseKey}:${occurrence}`;
            return (
              <li key={key}>
                <strong>Run {index + 1}</strong>
                <span
                  className={surfaceStateClass(surfaceStateLabel(run.state))}
                >
                  {surfaceStateLabel(run.state)}
                </span>
                {duration && <small>{duration}</small>}
              </li>
            );
          })}
        </ol>
      )}
      {lifecycle && (
        <div className="delegate-inspector-recovery">
          <strong>Recovery</strong>
          {lifecycle.diagnostic && <pre>{lifecycle.diagnostic}</pre>}
          {handle && (
            <p>
              Diagnostic artifact: <code>{handle}</code>
            </p>
          )}
        </div>
      )}
    </details>
  );
}

export interface DelegateInspectorRunOption {
  id: string;
  label: string;
  row: DelegateInspectionStatus;
  /** True when this option came from the durable summary response. */
  persisted?: boolean;
  /** True when the live runtime currently overlays this option. */
  live?: boolean;
}

export interface DelegateInspectorDetailState {
  run?: DelegateHistoryRunDetailResponse;
  loading?: boolean;
  error?: unknown;
}

export function delegateDetailHasError(
  detail: DelegateInspectorDetailState | undefined,
): boolean {
  return detail?.error != null && detail.loading !== true;
}

/** Keep a historical selection stable while the live composite is refreshed. */
export function selectedDelegateRunId(
  previousId: string | undefined,
  options: readonly DelegateInspectorRunOption[] | undefined,
  lineageChanged: boolean,
): string | undefined {
  if (
    !lineageChanged &&
    previousId &&
    options?.some((run) => run.id === previousId)
  )
    return previousId;
  return options?.at(-1)?.id;
}

/** Continuations share one child session; inspect that session, not per-run parent details. */
export function delegateTranscriptSessionId(
  row: DelegateInspectionStatus,
  runOptions?: readonly DelegateInspectorRunOption[],
  detail?: DelegateInspectorDetailState,
): string | undefined {
  const candidates = [
    detail?.run?.run.sessionId,
    ...[...(runOptions ?? [])].reverse().map((run) => run.row.sessionId),
    row.sessionId,
  ];
  return candidates.find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}
