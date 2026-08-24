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
      <span className={`delegate-meta-status ${surfaceStateClass(state)}`}>
        {state}
      </span>
      {duration && <span className="delegate-meta-duration">{duration}</span>}
      {row.allowWrites !== undefined && (
        <span
          className={`delegate-meta-access ${row.allowWrites ? 'delegate-row-access-rw' : 'delegate-row-access-ro'}`}
        >
          <span className="sr-only">
            {row.allowWrites ? 'read/write' : 'read-only'}
          </span>
          <span className="delegate-meta-access-full" aria-hidden="true">
            {row.allowWrites ? 'read/write' : 'read-only'}
          </span>
          <span className="delegate-meta-access-compact" aria-hidden="true">
            {row.allowWrites ? 'RW' : 'RO'}
          </span>
        </span>
      )}
      {row.isolation && (
        <span className="delegate-meta-workspace">
          {row.isolation} workspace
        </span>
      )}
      {row.capabilities?.map((capability) => (
        <span className="delegate-meta-capability" key={capability}>
          {capability}
        </span>
      ))}
      {row.context && (
        <span className="delegate-meta-context">{row.context}</span>
      )}
      {(row.route ?? row.workflow?.route) && (
        <span className="delegate-meta-route">
          {row.route ?? row.workflow?.route}
        </span>
      )}
      {row.runCount && row.runCount > 1 && (
        <span className="delegate-meta-attempts">{row.runCount} attempts</span>
      )}
      {lifecycle && (
        <span className="delegate-meta-recovery surface-failed">
          {!lifecycle.continuationUsable
            ? 'continuation unavailable'
            : lifecycle.writableBranchRetained
              ? 'branch retained'
              : lifecycle.readOnlySnapshotRetained
                ? 'snapshot retained'
                : `recovery ${lifecycle.reason}`}
        </span>
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
  details,
}: {
  row: DelegateInspectionStatus;
  now: number;
  details?: DelegateHistoryRunDetailResponse['run']['details'];
}) {
  const lifecycle = row.lifecycle;
  const runs = row.runs ?? [];
  const warnings = details?.runConfig?.warnings ?? row.warnings ?? [];
  const runKeyOccurrences = new Map<string, number>();
  const handle = artifactHandle(row);
  const setup = details?.setup;
  const runConfig = details?.runConfig;
  const fallbackInputIdentities = new Set(
    (row.workflow?.inputs ?? []).map((input) => input.identity),
  );
  const fallbackAfter = (row.workflow?.dependencies ?? []).filter(
    (dependency) => !fallbackInputIdentities.has(dependency),
  );
  type DisplayInput = {
    identity: string;
    label: string;
    kind: 'report' | 'handoff' | 'branch' | 'metadata';
    include?: readonly string[];
    content?: string;
    branch?: { branch?: string };
  };
  const fallbackInputs: DisplayInput[] = (row.workflow?.inputs ?? []).map(
    (input) => ({
      identity: input.identity,
      label: input.label ?? input.node,
      kind: input.include?.[0] ?? 'report',
      include: input.include?.length ? input.include : ['report'],
    }),
  );
  const inputs: DisplayInput[] = runConfig?.inputs?.length
    ? runConfig.inputs.map((input) => ({ ...input }))
    : fallbackInputs;
  const failed = ['error', 'aborted', 'timed-out'].includes(row.state);
  return (
    <div className="delegate-inspector-details">
      {(details?.task ?? row.details?.task) && (
        <section
          className="delegate-inspector-task"
          aria-labelledby="delegate-task-title"
        >
          <h2 id="delegate-task-title">Task</h2>
          <p>{details?.task ?? row.details?.task}</p>
        </section>
      )}
      {setup && (
        <section
          className="delegate-inspector-section"
          aria-labelledby="delegate-setup-title"
        >
          <h2 id="delegate-setup-title">Delegate setup</h2>
          <dl>
            {setup.cwd && (
              <div>
                <dt>Working directory</dt>
                <dd>{setup.cwd}</dd>
              </div>
            )}
            {setup.isolation && (
              <div>
                <dt>Workspace</dt>
                <dd>{setup.isolation}</dd>
              </div>
            )}
            {setup.worktree?.branch && (
              <div>
                <dt>Checkout</dt>
                <dd>{setup.worktree.branch}</dd>
              </div>
            )}
            {setup.worktree?.worktreePath && (
              <div>
                <dt>Worktree</dt>
                <dd>{setup.worktree.worktreePath}</dd>
              </div>
            )}
            {setup.worktree?.baseRef && (
              <div>
                <dt>Original base</dt>
                <dd>{setup.worktree.baseRef}</dd>
              </div>
            )}
            {setup.worktree?.baseHead && (
              <div>
                <dt>Base commit</dt>
                <dd>{setup.worktree.baseHead}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
      {(runConfig ||
        fallbackAfter.length > 0 ||
        inputs.length > 0 ||
        warnings.length > 0) && (
        <section
          className="delegate-inspector-section"
          aria-labelledby="delegate-run-config-title"
        >
          <h2 id="delegate-run-config-title">Run configuration</h2>
          <dl>
            {runConfig?.scope && (
              <div>
                <dt>Scope</dt>
                <dd>{runConfig.scope.join(', ')}</dd>
              </div>
            )}
            {(runConfig?.after ?? fallbackAfter).length > 0 && (
              <div>
                <dt>After</dt>
                <dd>{(runConfig?.after ?? fallbackAfter).join(', ')}</dd>
              </div>
            )}
            {runConfig?.parentContextNote && (
              <div>
                <dt>Parent context</dt>
                <dd>{runConfig.parentContextNote}</dd>
              </div>
            )}
            {runConfig?.refreshSource && (
              <div>
                <dt>Refresh source</dt>
                <dd>{runConfig.refreshSource}</dd>
              </div>
            )}
          </dl>
          {inputs.length > 0 && (
            <div className="delegate-inspector-inputs">
              <h3>Inputs</h3>
              {inputs.map((input) => (
                <details key={`${input.label}:${input.kind}:${input.identity}`}>
                  <summary>
                    {input.label}{' '}
                    <small>{input.include?.join(' + ') ?? input.kind}</small>
                  </summary>
                  {input.content ? (
                    <pre>{input.content}</pre>
                  ) : input.branch ? (
                    <p>Branch: {input.branch.branch ?? 'source branch'}</p>
                  ) : (
                    <p>No bounded content retained.</p>
                  )}
                </details>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="delegate-inspector-warnings" role="note">
              <strong>Setup warnings</strong>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      {details?.renderedPrompt && (
        <details className="delegate-rendered-prompt">
          <summary>Rendered prompt</summary>
          <pre>{details.renderedPrompt}</pre>
        </details>
      )}
      {runs.length > 1 && (
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
      {lifecycle && (failed || lifecycle.reason) && (
        <div className="delegate-inspector-recovery" role="alert">
          <strong>Recovery</strong>
          <span>{lifecycle.reason}</span>
          {lifecycle.diagnostic && <pre>{lifecycle.diagnostic}</pre>}
          {handle && (
            <p>
              Diagnostic artifact: <code>{handle}</code>
            </p>
          )}
        </div>
      )}
    </div>
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
