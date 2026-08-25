import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import { useEffect, useMemo, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type {
  DelegateStatus,
  DelegateStatusViewModel,
} from '../../../../../extensions/delegate/contribution';
import {
  delegateDisplayName,
  humanizeDelegateLogicalId,
} from '../delegate/display-name';
import {
  composeDelegateHistory,
  type DelegateCompositeGroup,
  type DelegateCompositeRun,
  type DelegateInspectionStatus,
  type DelegateWakePresentation,
} from '../delegate/history-compose';
import {
  surfaceElapsed,
  surfaceStateClass,
  surfaceStateLabel,
} from '../delegate/surface-state';
import {
  type DelegateInspectorDetailState,
  type DelegateInspectorRunOption,
  DelegateTranscriptInspector,
} from '../delegate-transcript-inspector';
import { SurfaceStats } from '../surface-drawer';
import { short, stateGlyph } from './state-glyphs';
import { WorkSurface } from './work-surface';

function workflowState(row: DelegateInspectionStatus): string {
  // A wake describes a follow-up effect, never the node's execution state.
  return row.workflow?.state ?? row.state;
}

function delegateRows(
  model: DelegateStatusViewModel,
): readonly DelegateStatus[] {
  return model.statuses.filter((row) => !row.lineageId.startsWith('wake:'));
}

function delegateStats(rows: readonly DelegateStatus[]) {
  return {
    running: rows.filter(
      (row) => surfaceStateLabel(workflowState(row)) === 'running',
    ).length,
    queued: rows.filter((row) =>
      ['queued', 'scheduled'].includes(surfaceStateLabel(workflowState(row))),
    ).length,
    done: rows.filter((row) => surfaceStateLabel(workflowState(row)) === 'done')
      .length,
    failed: rows.filter((row) =>
      ['failed', 'blocked'].includes(surfaceStateLabel(workflowState(row))),
    ).length,
    aborted: rows.filter(
      (row) => surfaceStateLabel(workflowState(row)) === 'aborted',
    ).length,
  };
}

function delegateWakeEffect(
  row: DelegateInspectionStatus,
  wakes: readonly DelegateWakePresentation[] | undefined,
): string | undefined {
  const identity = row.workflow?.identity;
  const ownWake = row.wake?.references.length === 1 ? row.wake : undefined;
  const wake =
    ownWake ??
    wakes?.find(
      (candidate) =>
        identity &&
        candidate.references.length === 1 &&
        candidate.references[0] === identity,
    );
  if (!wake) return undefined;
  if (wake.state === 'entered') return 'resumed parent';
  if (wake.state === 'cancelled') return 'wake cancelled';
  if (wake.state === 'blocked') return 'wake blocked';
  return 'resumes parent';
}

function delegateConsurfaceText(row: DelegateStatus): string | undefined {
  if ((row.runCount ?? 1) > 1) return `run ${row.runCount}`;
  return row.context;
}

export { delegateDisplayName, humanizeDelegateLogicalId };

export function delegateReferenceLabel(
  reference: string,
  rows: readonly DelegateInspectionStatus[],
): string {
  const logicalId = reference.replace(/@\d+$/, '');
  const row = rows.find(
    (candidate) => candidate.workflow?.identity === reference,
  );
  return row ? delegateDisplayName(row) : humanizeDelegateLogicalId(logicalId);
}

function delegateReferencesLabel(
  references: readonly string[],
  rows?: readonly DelegateInspectionStatus[],
): string {
  return references
    .map((reference) =>
      rows
        ? delegateReferenceLabel(reference, rows)
        : humanizeDelegateLogicalId(reference),
    )
    .join(', ');
}

function delegateWaitingRelationship(
  row: DelegateInspectionStatus,
  rows?: readonly DelegateInspectionStatus[],
): string | undefined {
  const workflow = row.workflow;
  if (!workflow) return undefined;
  const inputIdentities = new Set(
    (workflow.inputs ?? []).map((input) => input.identity),
  );
  const dependencies = workflow.waitingFor ?? workflow.dependencies;
  const after = dependencies.filter(
    (dependency) => !inputIdentities.has(dependency),
  );
  return after.length
    ? `after ${delegateReferencesLabel(after, rows)}`
    : undefined;
}

export function delegateActivityLabel(
  row: DelegateInspectionStatus,
  runState: string,
  pauseState?: string,
  includeRelationships = true,
  referenceRows?: readonly DelegateInspectionStatus[],
): string {
  if (pauseState === 'paused') return 'Paused at a safe boundary';
  if (pauseState === 'pausing') return 'Pausing at a safe boundary';
  if (includeRelationships) {
    const waitingRelationship = delegateWaitingRelationship(row, referenceRows);
    if (waitingRelationship) return waitingRelationship;
  }
  // Historical rows carry wake metadata on the invocation rather than in the
  // live wake list; keep this as a wait/action fallback, not a node state.
  if (includeRelationships && row.wake) {
    const references = delegateReferencesLabel(
      row.wake.references,
      referenceRows,
    );
    return row.wake.state === 'entered'
      ? `delivered for ${references}`
      : row.wake.state === 'pending' || row.wake.state === 'ready'
        ? `waiting for ${references}`
        : `wake ${row.wake.state} · ${references}`;
  }
  if (row.workflow?.state === 'blocked' && row.workflow.reason)
    return `blocked: ${row.workflow.reason}`;
  if (row.activity?.latestText || row.activity?.label)
    return row.activity.latestText || row.activity.label;
  if (runState === 'queued') return 'waiting for a slot';
  if (row.historical && !['queued', 'running'].includes(runState))
    return `${row.runCount ?? 1} run${row.runCount === 1 ? '' : 's'} · historical`;
  return 'starting';
}

export function delegateRowActivityLabel(
  row: DelegateInspectionStatus,
  wakes: readonly DelegateWakePresentation[] | undefined,
  runState: string,
  pauseState?: string,
  referenceRows?: readonly DelegateInspectionStatus[],
): string {
  const waitingRelationship = delegateWaitingRelationship(row, referenceRows);
  const action = delegateActivityLabel(
    row,
    runState,
    pauseState,
    false,
    referenceRows,
  );
  return [waitingRelationship ?? action, delegateWakeEffect(row, wakes)]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

export function selectedDelegateInspectionRow(
  selectedLineageId: string | undefined,
  rows: readonly DelegateInspectionStatus[],
  fallback: DelegateInspectionStatus | undefined,
): DelegateInspectionStatus | undefined {
  if (selectedLineageId === undefined) return fallback;
  return rows.find((row) => row.lineageId === selectedLineageId);
}

/** Resolve the durable option even when its live overlay carries a different run ID. */
export function selectedDelegateCompositeRun(
  group: DelegateCompositeGroup,
): DelegateCompositeRun {
  return (
    group.runs.find(
      (run) => run.id === group.row.runId || run.row.runId === group.row.runId,
    ) ?? {
      id: group.row.runId,
      label: '',
      row: group.row,
    }
  );
}

export function DelegateSurface({
  surface,
  pausedAt,
  history,
  historyLoading = false,
  historyError,
  onRunSelected,
  detail,
  store,
}: {
  surface: ExtensionSurface;
  pausedAt?: number;
  history?: import('@pi-dashboard/protocol').DelegateHistoryResponse;
  historyLoading?: boolean;
  historyError?: unknown;
  onRunSelected?: (run: DelegateCompositeRun) => void;
  detail?: DelegateInspectorDetailState;
  store?: import('@pi-dashboard/client').DashboardLiveStore;
}) {
  const model = surface.viewModel as DelegateStatusViewModel;
  const liveRows = delegateRows(model);
  const composite = useMemo(
    () =>
      history
        ? composeDelegateHistory(history, liveRows, model.wakes ?? [])
        : undefined,
    [history, liveRows, model.wakes],
  );
  const rows = composite?.groups.map((group) => group.row) ?? liveRows;
  const wakes = composite?.wakes ?? model.wakes ?? [];
  const wakeConditions = wakes.filter(
    (wake) =>
      wake.references.length > 1 &&
      !['entered', 'cancelled', 'blocked'].includes(wake.state),
  );
  const historyIncomplete = history?.truncated === true;
  const stats = delegateStats(rows);
  const [selectedLineageId, setSelectedLineageId] = useState<string>();
  const [lastInspectorRow, setLastInspectorRow] =
    useState<DelegateInspectionStatus>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const hasLiveElapsed = stats.running + stats.queued > 0;
  const [now, setNow] = useState(() => pausedAt ?? Date.now());
  useEffect(() => {
    if (
      rows.length > 0 &&
      selectedLineageId !== undefined &&
      rows.some((row) => row.lineageId === selectedLineageId)
    )
      return;
    if (rows.length > 0 && selectedLineageId === undefined) return;
    setSelectedLineageId(undefined);
    setLastInspectorRow(undefined);
    setInspectorOpen(false);
  }, [rows, selectedLineageId]);
  useEffect(() => {
    if (!hasLiveElapsed) return;
    if (pausedAt !== undefined) {
      setNow(pausedAt);
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasLiveElapsed, pausedAt]);
  const selectedGroup = composite?.groups.find(
    (group) => group.lineageId === selectedLineageId,
  );
  const inspectorRow = selectedDelegateInspectionRow(
    selectedLineageId,
    rows,
    lastInspectorRow,
  );
  const inspectorRuns: readonly DelegateInspectorRunOption[] | undefined =
    selectedGroup?.runs;
  const title = 'Delegates';
  const activeRows = rows.filter(
    (row) =>
      row.pauseState !== undefined ||
      ['running', 'queued'].includes(surfaceStateLabel(workflowState(row))),
  );
  const fallbackSummary = stats.failed
    ? `${stats.failed} need attention`
    : stats.aborted
      ? `${stats.aborted} stopped`
      : 'All delegates complete';
  const summaryText = historyLoading
    ? 'Loading delegate history…'
    : historyError
      ? 'Delegate history unavailable'
      : historyIncomplete
        ? 'History incomplete · some work omitted'
        : activeRows.length
          ? `${activeRows.length} active`
          : fallbackSummary;
  const summary =
    !historyLoading &&
    !historyError &&
    !historyIncomplete &&
    activeRows.length ? (
      <span className="surface-launcher-items">
        {activeRows.map((row) => {
          const state = row.pauseState ?? surfaceStateLabel(workflowState(row));
          return (
            <span
              className={`surface-launcher-item ${surfaceStateClass(state)}`}
              key={`${row.lineageId}:${row.runId}`}
            >
              <span className="surface-launcher-item-state" aria-hidden="true">
                {stateGlyph(state)}
              </span>
              <span className="surface-launcher-item-copy">
                <span>{delegateDisplayName(row)}</span>
              </span>
            </span>
          );
        })}
      </span>
    ) : (
      summaryText
    );
  const statsView = (
    <SurfaceStats
      className="work-header-stats"
      showZero
      stats={[
        { label: 'running', value: stats.running, tone: 'surface-running' },
        { label: 'queued', value: stats.queued, tone: 'surface-queued' },
        { label: 'failed', value: stats.failed, tone: 'surface-failed' },
        { label: 'stopped', value: stats.aborted, tone: 'surface-aborted' },
        { label: 'done', value: stats.done, tone: 'surface-done' },
      ]}
    />
  );
  const delegateSections =
    composite?.sections ??
    ([
      {
        id: 'active' as const,
        label: '',
        groups: rows.map((row) => ({
          lineageId: row.lineageId,
          row,
          runs: [],
          section: 'active' as const,
        })),
      },
    ] satisfies readonly {
      id: 'active';
      label: string;
      groups: readonly DelegateCompositeGroup[];
    }[]);
  const inspectorContent =
    inspectorRow && inspectorOpen ? (
      <DelegateTranscriptInspector
        row={inspectorRow}
        now={now}
        runOptions={inspectorRuns}
        detail={detail}
        onRunSelected={onRunSelected}
        store={store}
        isOpen={inspectorOpen}
        paused={pausedAt !== undefined}
        inline
        onClose={() => setInspectorOpen(false)}
      />
    ) : undefined;
  return (
    <WorkSurface
      title={title}
      label="Delegates"
      summary={summary}
      drawerSummary={summaryText}
      count={
        <span
          role="status"
          className="surface-counter-strip"
          aria-label={`${stats.running} running, ${stats.queued} queued, ${stats.failed + stats.aborted} need attention, ${stats.done} done`}
        >
          <span className="surface-running" aria-hidden="true">
            ● {stats.running}
          </span>
          <span className="surface-queued" aria-hidden="true">
            ○ {stats.queued}
          </span>
          <span className="surface-failed" aria-hidden="true">
            ! {stats.failed + stats.aborted}
          </span>
          <span className="surface-done" aria-hidden="true">
            ✓ {stats.done}
          </span>
        </span>
      }
      visibleCount={
        rows.length +
        wakeConditions.length +
        (historyIncomplete ? 1 : 0) +
        (historyLoading || historyError ? 1 : 0)
      }
      drawerClassName={`surface-drawer work-surface-drawer delegate-surface-drawer${inspectorContent ? ' delegate-transcript-drawer' : ''}`}
      headerStats={statsView}
      paused={pausedAt !== undefined}
      drawerTitle={
        inspectorRow && inspectorOpen
          ? `Delegate · ${delegateDisplayName(inspectorRow)}`
          : undefined
      }
      drawerContent={inspectorContent}
      hideDrawerHeader={inspectorContent !== undefined}
      onDrawerClose={() => {
        if (inspectorOpen) {
          setInspectorOpen(false);
          return false;
        }
        setSelectedLineageId(undefined);
        setLastInspectorRow(undefined);
      }}
    >
      <div className="delegate-scroll surface-scroll-region">
        {historyLoading && (
          <p className="delegate-history-status" role="status">
            Loading delegate history…
          </p>
        )}
        {historyError !== undefined && !historyLoading && (
          <p className="delegate-history-status" role="alert">
            Unable to load delegate history. Live delegate status remains
            available.
          </p>
        )}
        {wakeConditions.length > 0 && (
          <section
            className="delegate-wake-conditions"
            aria-label="Resume conditions"
          >
            {wakeConditions.map((wake) => {
              const waitingFor =
                'waitingFor' in wake && wake.waitingFor
                  ? wake.waitingFor
                  : wake.references;
              const ready = Math.max(
                0,
                wake.references.length - waitingFor.length,
              );
              return (
                <aside className="delegate-wake-condition" key={wake.id}>
                  <strong>Resume condition</strong>
                  <span>
                    {ready}/{wake.references.length} ready · waiting for{' '}
                    {waitingFor
                      .map((reference) =>
                        delegateReferenceLabel(reference, rows),
                      )
                      .join(', ')}
                  </span>
                </aside>
              );
            })}
          </section>
        )}
        <div className="delegate-rows">
          {delegateSections.map(
            (section) =>
              section.groups.length > 0 && (
                <section
                  className="delegate-section"
                  key={section.id}
                  aria-label={section.label || undefined}
                >
                  {section.label && (
                    <h3 className="delegate-section-title">{section.label}</h3>
                  )}
                  {section.groups.map((group: DelegateCompositeGroup) => {
                    const row = group.row;
                    const rawState = workflowState(row);
                    const runState = surfaceStateLabel(rawState);
                    const pauseState = row.pauseState;
                    const state = pauseState ?? runState;
                    const activityLabel = short(
                      delegateRowActivityLabel(
                        row,
                        wakes,
                        runState,
                        pauseState,
                        rows,
                      ),
                      140,
                    );
                    const name = delegateDisplayName(row);
                    const route = row.route ?? row.workflow?.route ?? '';
                    const context = delegateConsurfaceText(row) ?? '';
                    const access =
                      row.allowWrites === true ? 'read/write' : 'read-only';
                    const elapsedText = surfaceElapsed(
                      row.workflow?.startedAt ?? row.startedAt ?? row.createdAt,
                      row.workflow?.settledAt ?? row.finishedAt,
                      row.pausedAt ?? now,
                    );
                    return (
                      <div
                        className={`delegate-row ${surfaceStateClass(state)}`}
                        key={`${surface.id}-${row.id}`}
                      >
                        <AriaButton
                          type="button"
                          className="delegate-row-toggle"
                          aria-haspopup="dialog"
                          onPress={() => {
                            onRunSelected?.(
                              selectedDelegateCompositeRun(group),
                            );
                            setSelectedLineageId(row.lineageId);
                            setLastInspectorRow(row);
                            setInspectorOpen(true);
                          }}
                        >
                          <span className="surface-state" aria-hidden="true">
                            {stateGlyph(state)}
                          </span>
                          <span className="delegate-row-main">
                            <span className="delegate-row-name">
                              <strong>{name}</strong>
                            </span>
                            <small
                              className={`delegate-row-action ${surfaceStateClass(state)}`}
                            >
                              {activityLabel}
                            </small>
                          </span>
                          <span className="delegate-row-meta">
                            <span
                              className={`delegate-row-status ${surfaceStateClass(state)}`}
                            >
                              {state}
                              {elapsedText ? ` · ${elapsedText}` : ''}
                            </span>
                            <span className="delegate-row-properties">
                              {context && (
                                <span className="delegate-row-context">
                                  {context}
                                </span>
                              )}
                              {context && access ? ' · ' : null}
                              {access && (
                                <span
                                  className={
                                    row.allowWrites === true
                                      ? 'delegate-row-access-rw'
                                      : 'delegate-row-access-ro'
                                  }
                                >
                                  {access}
                                </span>
                              )}
                              {(context || access) && route ? ' · ' : null}
                              {route && (
                                <span className="delegate-row-route">
                                  {route}
                                </span>
                              )}
                            </span>
                          </span>
                          <span
                            className="delegate-row-chevron"
                            aria-hidden="true"
                          >
                            ›
                          </span>
                        </AriaButton>
                      </div>
                    );
                  })}
                </section>
              ),
          )}
        </div>
      </div>
    </WorkSurface>
  );
}
