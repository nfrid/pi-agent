import type {
  DelegateHistoryRunDetailResponse,
  DelegateUsage,
} from '@pi-dashboard/protocol';
import { Markdown } from '../../Markdown';
import { formatCompactCount } from '../../shared/lib/format';
import type { DelegateInspectionStatus } from '../delegate/history-compose';
import {
  surfaceElapsed,
  surfaceStateClass,
  surfaceStateLabel,
} from '../delegate/surface-state';
import { DashboardTime } from '../timestamp';

const DEFAULT_CONTEXT_WINDOW = 272_000;

function ContextUsage({
  usage,
  label,
  compact = false,
}: {
  usage: DelegateUsage | undefined;
  label: string;
  compact?: boolean;
}) {
  if (!usage) return null;
  const limit = usage.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const percent = Math.round((usage.contextTokens / limit) * 100);
  return (
    <details className={`delegate-context-usage${compact ? ' compact' : ''}`}>
      <summary aria-label={`${label} context window ${percent}%`}>
        <span className="delegate-context-wide">
          {formatCompactCount(usage.contextTokens)} /{' '}
          {formatCompactCount(limit)} ·{' '}
        </span>
        <strong>{percent}%</strong>
      </summary>
      <div className="delegate-context-popover">
        <strong>{label} context</strong>
        <dl>
          <div>
            <dt>Used</dt>
            <dd>{formatCompactCount(usage.contextTokens)}</dd>
          </div>
          <div>
            <dt>Limit</dt>
            <dd>{formatCompactCount(limit)}</dd>
          </div>
          <div>
            <dt>Input</dt>
            <dd>{formatCompactCount(usage.input)}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{formatCompactCount(usage.output)}</dd>
          </div>
          <div>
            <dt>Cache read</dt>
            <dd>{formatCompactCount(usage.cacheRead)}</dd>
          </div>
          <div>
            <dt>Cache write</dt>
            <dd>{formatCompactCount(usage.cacheWrite)}</dd>
          </div>
          <div>
            <dt>Turns</dt>
            <dd>{usage.turns}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>${usage.cost.toFixed(4)}</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

function setupBranch(
  details: DelegateHistoryRunDetailResponse['run']['details'] | undefined,
): string | undefined {
  return details?.setup?.worktree?.branch;
}

export function DelegateInspectorMetadata({
  row,
  now,
  details,
}: {
  row: DelegateInspectionStatus;
  now: number;
  details?: DelegateHistoryRunDetailResponse['run']['details'];
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
  const route = row.route ?? row.workflow?.route;
  const branch = setupBranch(details ?? row.details);
  return (
    <fieldset
      className="delegate-inspector-metadata"
      aria-label="Delegate setup"
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
      {row.isolation && !branch && (
        <span className="delegate-meta-workspace">
          {row.isolation === 'worktree' ? 'isolated' : 'shared'}
        </span>
      )}
      {row.capabilities?.map((capability) => (
        <span className="delegate-meta-capability" key={capability}>
          {capability}
        </span>
      ))}
      {route && <span className="delegate-meta-route">{route}</span>}
      {branch && <span className="delegate-meta-branch">{branch}</span>}
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
      <ContextUsage
        usage={row.usage}
        label={row.state === 'running' ? 'Current' : 'Final'}
      />
    </fieldset>
  );
}

export function DelegateParentRequest({
  run,
  index,
  details,
  loading,
  error,
  onDetailsRequested,
}: {
  run: DelegateInspectorRunOption;
  index: number;
  details?: DelegateHistoryRunDetailResponse['run']['details'];
  loading?: boolean;
  error?: boolean;
  onDetailsRequested?: () => void;
}) {
  const row = run.row;
  const effectiveDetails = details ?? row.details;
  const task = effectiveDetails?.task ?? row.task ?? 'Delegate request';
  const setup = effectiveDetails?.setup;
  const config = effectiveDetails?.runConfig;
  const branch = setupBranch(effectiveDetails);
  const immediate = [
    ...(config?.scope?.length ? [`scope ${config.scope.join(', ')}`] : []),
    ...(config?.inputs?.length
      ? [
          `${config.inputs.length} input${config.inputs.length === 1 ? '' : 's'}`,
        ]
      : []),
    ...(config?.after?.length ? [`after ${config.after.join(', ')}`] : []),
  ];
  return (
    <article className="delegate-parent-request">
      <header>
        <strong>{index === 0 ? 'Parent request' : 'Parent follow-up'}</strong>
        <ContextUsage
          usage={row.usage}
          label={row.state === 'running' ? 'Current' : 'Final'}
          compact
        />
        <DashboardTime className="transcript-time" timestamp={row.createdAt} />
      </header>
      <Markdown>{task}</Markdown>
      {immediate.length > 0 && (
        <p className="delegate-request-summary">{immediate.join(' · ')}</p>
      )}
      <details
        className="delegate-request-details"
        onToggle={(event) => {
          if (event.currentTarget.open && !effectiveDetails)
            onDetailsRequested?.();
        }}
      >
        <summary>Details</summary>
        {loading && !effectiveDetails ? (
          <p role="status">Loading setup…</p>
        ) : error && !effectiveDetails ? (
          <p role="alert">Unable to load setup details.</p>
        ) : effectiveDetails ? (
          <div className="delegate-request-details-body">
            <dl>
              {setup?.cwd && (
                <div>
                  <dt>Working directory</dt>
                  <dd>{setup.cwd}</dd>
                </div>
              )}
              {branch && (
                <div>
                  <dt>Branch</dt>
                  <dd>{branch}</dd>
                </div>
              )}
              {setup?.worktree?.worktreePath && (
                <div>
                  <dt>Worktree</dt>
                  <dd>{setup.worktree.worktreePath}</dd>
                </div>
              )}
              {setup?.worktree?.baseRef && (
                <div>
                  <dt>Base</dt>
                  <dd>{setup.worktree.baseRef}</dd>
                </div>
              )}
              {config?.parentContextNote && (
                <div>
                  <dt>Parent context</dt>
                  <dd>
                    <Markdown>{config.parentContextNote}</Markdown>
                  </dd>
                </div>
              )}
              {config?.refreshSource && (
                <div>
                  <dt>Refresh source</dt>
                  <dd>{config.refreshSource}</dd>
                </div>
              )}
            </dl>
            {config?.inputs?.map((input) => (
              <details className="delegate-request-input" key={input.identity}>
                <summary>{input.label}</summary>
                {input.content ? (
                  <Markdown>{input.content}</Markdown>
                ) : input.branch ? (
                  <p>{input.branch.branch ?? 'Source branch'}</p>
                ) : (
                  <p>No retained content.</p>
                )}
              </details>
            ))}
            {config?.warnings?.length ? (
              <ul className="delegate-inspector-warnings">
                {config.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {effectiveDetails.renderedPrompt && (
              <details className="delegate-rendered-prompt">
                <summary>Exact prompt</summary>
                <div className="delegate-rendered-prompt-markdown">
                  <Markdown>{effectiveDetails.renderedPrompt}</Markdown>
                </div>
              </details>
            )}
          </div>
        ) : (
          <p>No retained setup details.</p>
        )}
      </details>
    </article>
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
