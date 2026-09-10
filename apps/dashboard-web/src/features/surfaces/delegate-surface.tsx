import type { DashboardHttpClient } from '@pi-dashboard/client';
import type {
  DelegateStatus,
  DelegateStatusViewModel,
  ExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import { useEffect, useMemo, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
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
  DelegateInspectorHeaderActions,
  type DelegateInspectorRunOption,
  DelegateTranscriptInspector,
} from '../delegate-transcript-inspector';
import { SurfaceStack, SurfaceStats } from '../surface-stack';
import { short, stateGlyph } from './state-glyphs';
import { WorkSurface } from './work-surface';

function workflowState(
  row: Pick<DelegateInspectionStatus, 'workflow' | 'state'>,
): string {
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

export type DelegatePanelBucket = 'active' | 'waiting' | 'failed' | 'finished';

export function delegatePanelBucket(
  row: Pick<DelegateInspectionStatus, 'state' | 'pauseState' | 'workflow'>,
): DelegatePanelBucket {
  const state = row.pauseState ?? surfaceStateLabel(workflowState(row));
  if (state === 'running' || state === 'pausing' || state === 'paused')
    return 'active';
  if (state === 'queued') return 'waiting';
  if (state === 'failed' || state === 'blocked') return 'failed';
  return 'finished';
}

export function delegatePanelCounters(
  rows: readonly Pick<
    DelegateInspectionStatus,
    'state' | 'pauseState' | 'workflow'
  >[],
): Record<DelegatePanelBucket, number> {
  return rows.reduce(
    (counts, row) => {
      counts[delegatePanelBucket(row)] += 1;
      return counts;
    },
    { active: 0, waiting: 0, failed: 0, finished: 0 },
  );
}

export function orderDelegatePanelGroups(
  groups: readonly DelegateCompositeGroup[],
): readonly DelegateCompositeGroup[] {
  const order: Record<DelegatePanelBucket, number> = {
    active: 0,
    waiting: 1,
    failed: 2,
    finished: 3,
  };
  return groups
    .map((group, index) => ({ group, index }))
    .sort(
      (left, right) =>
        order[delegatePanelBucket(left.group.row)] -
          order[delegatePanelBucket(right.group.row)] ||
        left.index - right.index,
    )
    .map(({ group }) => group);
}

export function isParentResumeGate(wake: {
  id: string;
  state: string;
  references: readonly string[];
}): boolean {
  return (
    wake.references.length > 1 &&
    !wake.id.startsWith('eager-') &&
    !['entered', 'cancelled', 'blocked'].includes(wake.state)
  );
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
    ? `waiting for ${delegateReferencesLabel(after, rows)}`
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
  client,
  activityPanel = false,
}: {
  surface: ExtensionSurface;
  pausedAt?: number;
  history?: import('@pi-dashboard/protocol').DelegateHistoryResponse;
  historyLoading?: boolean;
  historyError?: unknown;
  onRunSelected?: (run: DelegateCompositeRun) => void;
  detail?: DelegateInspectorDetailState;
  store?: import('@pi-dashboard/client').DashboardLiveStore;
  client?: DashboardHttpClient;
  activityPanel?: boolean;
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
  const wakeConditions = wakes.filter(isParentResumeGate);
  const historyIncomplete = history?.truncated === true;
  const stats = delegateStats(rows);
  const [selectedLineageId, setSelectedLineageId] = useState<string>();
  const [lastInspectorRow, setLastInspectorRow] =
    useState<DelegateInspectionStatus>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
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
  const summaryText = historyIncomplete
    ? 'History incomplete · some work omitted'
    : activeRows.length
      ? `${activeRows.length} active`
      : historyLoading
        ? 'Loading delegate history…'
        : fallbackSummary;
  const summary =
    !historyIncomplete && activeRows.length ? (
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
  const inspectorPages =
    inspectorRow && inspectorOpen
      ? [
          {
            id: `delegate-${inspectorRow.lineageId}`,
            title: `Delegate · ${delegateDisplayName(inspectorRow)}`,
            eyebrow: null,
            backLabel: 'Back to delegates',
            headerContent: (
              <div className="delegate-inspector-header-content">
                <DelegateInspectorHeaderActions
                  row={inspectorRow}
                  runOptions={inspectorRuns}
                  detail={detail}
                />
              </div>
            ),
            children: (
              <div className="delegate-inspector-inline">
                <DelegateTranscriptInspector
                  row={inspectorRow}
                  now={now}
                  runOptions={inspectorRuns}
                  detail={detail}
                  onRunSelected={onRunSelected}
                  store={store}
                  client={client}
                  isOpen={inspectorOpen}
                />
              </div>
            ),
          },
        ]
      : [];
  const openDelegateInspector = (group: DelegateCompositeGroup) => {
    const row = group.row;
    onRunSelected?.(selectedDelegateCompositeRun(group));
    setSelectedLineageId(row.lineageId);
    setLastInspectorRow(row);
    setInspectorOpen(true);
  };
  const renderDelegateRow = (group: DelegateCompositeGroup) => {
    const row = group.row;
    const rawState = workflowState(row);
    const runState = surfaceStateLabel(rawState);
    const pauseState = row.pauseState;
    const state = pauseState ?? runState;
    const activityLabel = short(
      delegateRowActivityLabel(row, wakes, runState, pauseState, rows),
      140,
    );
    const name = delegateDisplayName(row);
    const route = row.route ?? row.workflow?.route ?? '';
    const context = delegateConsurfaceText(row) ?? '';
    const access = row.allowWrites === true ? 'read/write' : 'read-only';
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
          onPress={() => openDelegateInspector(group)}
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
            <span className={`delegate-row-status ${surfaceStateClass(state)}`}>
              {state}
              {elapsedText ? ` · ${elapsedText}` : ''}
            </span>
            <span className="delegate-row-properties">
              {context && (
                <span className="delegate-row-context">{context}</span>
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
              {route && <span className="delegate-row-route">{route}</span>}
            </span>
          </span>
          <span className="delegate-row-chevron" aria-hidden="true">
            ›
          </span>
        </AriaButton>
      </div>
    );
  };
  const renderActivityDelegateRow = (group: DelegateCompositeGroup) =>
    renderDelegateRow(group);
  const panelGroups = orderDelegatePanelGroups(
    composite?.groups ??
      rows.map((row) => ({
        lineageId: row.lineageId,
        row,
        runs: [],
        section: 'active' as const,
      })),
  );
  const panelCounters = delegatePanelCounters(rows);
  const closeInspector = () => {
    setInspectorOpen(false);
    setSelectedLineageId(undefined);
    setLastInspectorRow(undefined);
  };
  if (activityPanel)
    return (
      <>
        <section
          className="activity-panel-section"
          aria-label="Delegates"
          tabIndex={-1}
        >
          <button
            type="button"
            className="activity-panel-header activity-panel-header-toggle"
            aria-label={
              panelExpanded
                ? 'Show fewer delegates'
                : 'Show all delegates, including finished work'
            }
            aria-expanded={panelExpanded}
            onClick={() => setPanelExpanded((value) => !value)}
          >
            <h2>Delegates</h2>
            <span
              className="activity-panel-counters"
              role="status"
              aria-label={`${panelCounters.active} active, ${panelCounters.waiting} waiting, ${panelCounters.failed} failed, ${panelCounters.finished} finished`}
            >
              <span
                className="activity-panel-counter-active"
                title={`Active: ${panelCounters.active}`}
              >
                <span aria-hidden="true">●</span> {panelCounters.active}
              </span>
              <span
                className="activity-panel-counter-waiting"
                title={`Waiting: ${panelCounters.waiting}`}
              >
                <span aria-hidden="true">○</span> {panelCounters.waiting}
              </span>
              <span
                className="activity-panel-counter-failed"
                title={`Failed: ${panelCounters.failed}`}
              >
                <span aria-hidden="true">!</span> {panelCounters.failed}
              </span>
              <span
                className="activity-panel-counter-finished"
                title={`Finished: ${panelCounters.finished}`}
              >
                <span aria-hidden="true">✓</span> {panelCounters.finished}
              </span>
            </span>
          </button>
          {historyLoading && (
            <p className="delegate-history-status" role="status">
              Loading delegate history…
            </p>
          )}
          {historyError !== undefined && !historyLoading && (
            <p className="delegate-history-status" role="status">
              No delegate history.
            </p>
          )}
          {historyIncomplete && (
            <p className="delegate-history-status" role="status">
              History incomplete · some work omitted
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
                    <strong>Parent resume gate</strong>
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
          <div className="activity-panel-rows">
            {panelGroups
              .filter((group) => delegatePanelBucket(group.row) !== 'finished')
              .map(renderActivityDelegateRow)}
            {panelExpanded &&
              panelGroups
                .filter(
                  (group) => delegatePanelBucket(group.row) === 'finished',
                )
                .map(renderActivityDelegateRow)}
          </div>
        </section>
        <SurfaceStack
          pages={inspectorPages}
          kind="inspector"
          size="wide"
          className="surface-drawer work-surface-drawer delegate-surface-drawer delegate-transcript-drawer"
          onDepthChange={(depth) => {
            if (depth < 1) closeInspector();
          }}
          onClose={closeInspector}
        />
      </>
    );
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
      shortcut={{ code: 'KeyD' }}
      visibleCount={
        rows.length +
        wakeConditions.length +
        (historyIncomplete ? 1 : 0) +
        (historyLoading || historyError ? 1 : 0)
      }
      drawerClassName={`surface-drawer work-surface-drawer delegate-surface-drawer${inspectorPages.length ? ' delegate-transcript-drawer' : ''}`}
      headerStats={statsView}
      paused={pausedAt !== undefined}
      pages={inspectorPages}
      onPageDepthChange={(depth) => {
        if (depth <= 1) setInspectorOpen(false);
        if (depth < 1) {
          setSelectedLineageId(undefined);
          setLastInspectorRow(undefined);
        }
      }}
    >
      <div className="delegate-scroll surface-scroll-region">
        {historyLoading && (
          <p className="delegate-history-status" role="status">
            Loading delegate history…
          </p>
        )}
        {historyError !== undefined && !historyLoading && (
          <p className="delegate-history-status" role="status">
            No delegate history.
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
                  <strong>Parent resume gate</strong>
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
                  {section.groups.map(renderDelegateRow)}
                </section>
              ),
          )}
        </div>
      </div>
    </WorkSurface>
  );
}
