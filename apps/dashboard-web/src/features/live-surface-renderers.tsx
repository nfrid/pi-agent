import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type {
  DelegateStatus,
  DelegateStatusViewModel,
} from '../../../../extensions/delegate/contribution';
import type {
  TaskStateViewModel,
  TaskSurfaceTask,
} from '../../../../extensions/tasks/contribution';
import type { DashboardRendererContext } from '../renderer-registry';
import {
  composeDelegateHistory,
  type DelegateCompositeGroup,
  type DelegateCompositeRun,
  type DelegateInspectionStatus,
} from './delegate-history';
import {
  type DelegateInspectorDetailState,
  type DelegateInspectorRunOption,
  DelegateTranscriptInspector,
} from './delegate-transcript-inspector';
import { PauseIcon } from './pause-icon';
import { SurfaceDrawer, SurfaceStats } from './surface-drawer';

function text(value: string | undefined, fallback = ''): string {
  return value?.trim() || fallback;
}

function short(value: string, max = 180): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function workflowState(row: DelegateInspectionStatus): string {
  return row.wake?.state ?? row.workflow?.state ?? row.state;
}

function stateLabel(value: string): string {
  const state = value.toLowerCase();
  if (state === 'running' || state === 'doing') return 'running';
  if (
    state === 'queued' ||
    state === 'todo' ||
    state === 'scheduled' ||
    state === 'pending' ||
    state === 'ready'
  )
    return 'queued';
  if (
    state === 'success' ||
    state === 'done' ||
    state === 'completed' ||
    state === 'entered'
  )
    return 'done';
  if (state === 'aborted') return 'aborted';
  if (state === 'dropped' || state === 'cancelled') return 'dropped';
  if (
    state === 'error' ||
    state === 'failed' ||
    state === 'blocked' ||
    state === 'timed-out'
  )
    return state === 'blocked' ? 'blocked' : 'failed';
  return state;
}

function stateGlyph(state: string): ReactNode {
  if (state === 'paused') return <PauseIcon className="pause-icon" />;
  if (state === 'pausing')
    return <span className="pausing-icon" aria-hidden="true" />;
  if (state === 'running') return '●';
  if (state === 'done') return '✓';
  if (state === 'failed' || state === 'blocked') return '!';
  if (state === 'aborted') return '■';
  if (state === 'dropped') return '−';
  return '○';
}

function stateClass(state: string): string {
  if (state === 'paused') return 'surface-paused';
  if (state === 'pausing') return 'surface-pausing';
  if (state === 'running') return 'surface-running';
  if (state === 'done') return 'surface-done';
  if (state === 'failed' || state === 'blocked') return 'surface-failed';
  if (state === 'aborted') return 'surface-aborted';
  if (state === 'dropped') return 'surface-dropped';
  return 'surface-queued';
}

function elapsed(
  start: unknown,
  finish: unknown,
  now = Date.now(),
): string | undefined {
  if (typeof start !== 'number') return undefined;
  const end = typeof finish === 'number' ? finish : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function delegateRows(
  model: DelegateStatusViewModel,
): readonly DelegateStatus[] {
  return model.statuses;
}

function delegateStats(rows: readonly DelegateStatus[]) {
  return {
    running: rows.filter((row) => stateLabel(workflowState(row)) === 'running')
      .length,
    queued: rows.filter((row) =>
      ['queued', 'scheduled'].includes(stateLabel(workflowState(row))),
    ).length,
    done: rows.filter((row) => stateLabel(workflowState(row)) === 'done')
      .length,
    failed: rows.filter((row) =>
      ['failed', 'blocked'].includes(stateLabel(workflowState(row))),
    ).length,
    aborted: rows.filter((row) => stateLabel(workflowState(row)) === 'aborted')
      .length,
  };
}

function focusAfterSurfaceHides(launcher: HTMLButtonElement | null) {
  if (
    !launcher ||
    (document.activeElement !== launcher &&
      document.activeElement !== document.body)
  )
    return;
  const fallback = document.querySelector<HTMLElement>(
    '[aria-label="Send a message"] [role="textbox"]',
  );
  if (fallback?.getClientRects().length)
    fallback.focus({ preventScroll: true });
}

function WorkSurface({
  title,
  label,
  summary,
  summaryDetail,
  count,
  visibleCount,
  drawerClassName = 'surface-drawer work-surface-drawer',
  headerStats,
  paused = false,
  children,
}: {
  title: string;
  label: string;
  summary: string;
  summaryDetail?: ReactNode;
  count: ReactNode;
  visibleCount: number;
  drawerClassName?: string;
  headerStats?: ReactNode;
  paused?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(visibleCount > 0);
  const launcherRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (visibleCount > 0) {
      setVisible(true);
      return;
    }
    // A delta can remove every row while the surface is open. Close the
    // controlled drawer first so its exit/focus handling does not retain a
    // launcher or transcript row that no longer exists.
    setOpen(false);
    const timeout = window.setTimeout(() => {
      focusAfterSurfaceHides(launcherRef.current);
      setVisible(false);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [visibleCount]);
  if (!visible) return null;
  return (
    <>
      <article className="extension-surface" aria-label={title}>
        <AriaButton
          ref={launcherRef}
          type="button"
          className="surface-launcher"
          aria-haspopup="dialog"
          aria-expanded={open}
          onPress={() => setOpen((current) => !current)}
        >
          <span className="surface-title">
            <span className="surface-title-line">
              <span className="eyebrow">{label}</span>
              <span className="surface-count">{count}</span>
            </span>
            <strong>{summary}</strong>
            {summaryDetail}
          </span>
          <span className="surface-chevron" aria-hidden="true">
            ›
          </span>
        </AriaButton>
      </article>
      <SurfaceDrawer
        title={title}
        eyebrow={label}
        hideTitle
        headerSummary={summary}
        className={drawerClassName}
        headerContent={headerStats}
        isOpen={open}
        paused={paused}
        onClose={() => setOpen(false)}
      >
        <div className="work-surface-content">{children}</div>
      </SurfaceDrawer>
    </>
  );
}

function delegateContext(row: DelegateStatus): string | undefined {
  if ((row.runCount ?? 1) > 1) return `run ${row.runCount}`;
  return row.context;
}

export function delegateActivityLabel(
  row: DelegateInspectionStatus,
  runState: string,
  pauseState?: string,
): string {
  if (pauseState === 'paused') return 'Paused at a safe boundary';
  if (pauseState === 'pausing') return 'Pausing at a safe boundary';
  if (row.wake)
    return row.wake.state === 'entered'
      ? `delivered for ${row.wake.references.join(', ')}`
      : row.wake.state === 'pending' || row.wake.state === 'ready'
        ? `waiting for ${row.wake.references.join(', ')}`
        : `wake ${row.wake.state} · ${row.wake.references.join(', ')}`;
  if (row.workflow?.waitingFor?.length)
    return `waiting for ${row.workflow.waitingFor.join(', ')}`;
  if (row.workflow?.state === 'blocked' && row.workflow.reason)
    return `blocked: ${row.workflow.reason}`;
  if (row.activity?.latestText || row.activity?.label)
    return row.activity.latestText || row.activity.label;
  if (runState === 'queued') return 'waiting for a slot';
  if (row.historical && !['queued', 'running'].includes(runState))
    return `${row.runCount ?? 1} run${row.runCount === 1 ? '' : 's'} · historical`;
  return 'starting';
}

export function selectedDelegateInspectionRow(
  selectedLineageId: string | undefined,
  rows: readonly DelegateInspectionStatus[],
  fallback: DelegateInspectionStatus | undefined,
): DelegateInspectionStatus | undefined {
  if (selectedLineageId === undefined) return fallback;
  return rows.find((row) => row.lineageId === selectedLineageId);
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
    () => (history ? composeDelegateHistory(history, liveRows) : undefined),
    [history, liveRows],
  );
  const rows = composite?.groups.map((group) => group.row) ?? liveRows;
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
  const active = rows.find(
    (row) =>
      row.pauseState !== undefined ||
      ['running', 'queued'].includes(stateLabel(workflowState(row))),
  );
  const summary = historyLoading
    ? 'Loading delegate history…'
    : historyError
      ? 'Delegate history unavailable'
      : historyIncomplete
        ? 'History incomplete · some work omitted'
        : active
          ? short(text(active.name, 'Subagent'), 42)
          : stats.failed
            ? `${stats.failed} need attention`
            : stats.aborted
              ? `${stats.aborted} stopped`
              : 'All delegates complete';
  const activeCount = rows.filter(
    (row) =>
      row.pauseState !== undefined ||
      ['running', 'queued'].includes(stateLabel(workflowState(row))),
  ).length;
  const finishedCount = rows.length - activeCount;
  const statsView = (
    <SurfaceStats
      className="work-header-stats"
      showZero
      stats={[
        { label: 'active', value: activeCount, tone: 'surface-running' },
        { label: 'finished', value: finishedCount },
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
  return (
    <>
      <WorkSurface
        title={title}
        label="Delegates"
        summary={summary}
        summaryDetail={
          active?.workflow ? (
            <small className="surface-summary-detail">
              {active.workflow.identity} · {active.workflow.state}
              {active.workflow.reason ? ` · ${active.workflow.reason}` : ''}
              {active.workflow.deliveredToParent ? ' · delivered' : ''}
              {model.wakes?.length
                ? ` · wake ${model.wakes.map((wake) => `${wake.id} (${wake.state})`).join(', ')}`
                : ''}
            </small>
          ) : undefined
        }
        count={`${activeCount} active · ${finishedCount} finished`}
        visibleCount={
          rows.length +
          (historyIncomplete ? 1 : 0) +
          (historyLoading || historyError ? 1 : 0)
        }
        drawerClassName="surface-drawer work-surface-drawer delegate-surface-drawer"
        headerStats={statsView}
        paused={pausedAt !== undefined}
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
          {model.wakes && model.wakes.length > 0 && (
            <section className="delegate-wakes" aria-label="Wake rules">
              <h3 className="delegate-section-title">Wake rules</h3>
              {model.wakes.map((wake) => (
                <div className="delegate-wake-row" key={wake.id}>
                  <strong>{wake.id}</strong>
                  <span>{wake.state}</span>
                  <small>
                    {wake.waitingFor?.length
                      ? `waiting for ${wake.waitingFor.join(', ')}`
                      : wake.references.join(', ')}
                  </small>
                </div>
              ))}
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
                      <h3 className="delegate-section-title">
                        {section.label}
                      </h3>
                    )}
                    {section.groups.map((group: DelegateCompositeGroup) => {
                      const row = group.row;
                      const rawState = workflowState(row);
                      const runState = stateLabel(rawState);
                      const pauseState = row.pauseState;
                      const state = pauseState ?? runState;
                      const activityLabel = short(
                        delegateActivityLabel(row, runState, pauseState),
                        140,
                      );
                      const name = short(row.name, 70);
                      const route = row.route ?? '';
                      const context = delegateContext(row) ?? '';
                      const access =
                        row.allowWrites === true ? 'read/write' : 'read-only';
                      const elapsedText = elapsed(
                        row.workflow?.startedAt ??
                          row.startedAt ??
                          row.createdAt,
                        row.workflow?.settledAt ?? row.finishedAt,
                        row.pausedAt ?? now,
                      );
                      return (
                        <div
                          className={`delegate-row ${stateClass(state)}`}
                          key={`${surface.id}-${row.id}`}
                        >
                          <AriaButton
                            type="button"
                            className="delegate-row-toggle"
                            aria-haspopup="dialog"
                            onPress={() => {
                              onRunSelected?.(
                                group.runs.find(
                                  (run) => run.id === row.runId,
                                ) ?? {
                                  id: row.runId,
                                  label: '',
                                  row,
                                },
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
                              <strong>{name}</strong>
                              {row.workflow?.identity && (
                                <small>{row.workflow.identity}</small>
                              )}
                              <small>{activityLabel}</small>
                            </span>
                            <span className="delegate-row-meta">
                              <span className="delegate-row-status">
                                {rawState}
                                {elapsedText ? ` · ${elapsedText}` : ''}
                              </span>
                              <span className="delegate-row-properties">
                                {[context, access, route]
                                  .filter(Boolean)
                                  .join(' · ')}
                                {elapsedText && (
                                  <span className="delegate-row-mobile-elapsed">
                                    {' · '}
                                    {elapsedText}
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
      {inspectorRow && (
        <DelegateTranscriptInspector
          row={inspectorRow}
          now={now}
          runOptions={inspectorRuns}
          detail={detail}
          onRunSelected={onRunSelected}
          store={store}
          isOpen={inspectorOpen}
          paused={pausedAt !== undefined}
          onClose={() => setInspectorOpen(false)}
        />
      )}
    </>
  );
}

function taskRows(model: TaskStateViewModel): readonly TaskSurfaceTask[] {
  return model.tasks;
}

function taskDependencies(row: TaskSurfaceTask): readonly string[] {
  return row.dependsOn.slice(0, 6);
}

function TasksSurface({
  surface,
  paused,
}: {
  surface: ExtensionSurface;
  paused?: boolean;
}) {
  const model = surface.viewModel as TaskStateViewModel;
  const rows = taskRows(model);
  const completed = model.stats.done;
  const total = model.stats.total;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const title = 'Tasks';
  const current = rows.find((row) => stateLabel(row.status) === 'running');
  const summary = current
    ? short(text(current.text, 'Task in progress'), 42)
    : completed === total
      ? 'All tasks complete'
      : model.stats.active === 0
        ? 'No active tasks'
        : `${model.stats.active} remaining`;
  return (
    <WorkSurface
      title={title}
      label="Tasks"
      summary={summary}
      count={`${completed}/${total}`}
      visibleCount={total}
      paused={paused}
      headerStats={
        <SurfaceStats
          className="work-header-stats"
          showZero
          stats={[
            {
              label: 'active',
              value: model.stats.active,
              tone: 'surface-running',
            },
            { label: 'finished', value: completed },
          ]}
        />
      }
    >
      <div
        className="task-progress"
        role="progressbar"
        aria-label="Task progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span>
          <strong>{completed}</strong> of {total} complete
        </span>
        <span className="task-progress-track" aria-hidden="true">
          <i style={{ width: `${progress}%` }} />
        </span>
      </div>
      <div className="task-rows surface-detail-list surface-scroll-region">
        {rows.map((row) => {
          const state = stateLabel(row.status);
          const id = row.id;
          const priority = row.priority;
          const dependencies = taskDependencies(row);
          return (
            <div
              className={`task-row ${stateClass(state)}`}
              key={`${surface.id}-${id}`}
            >
              <span className="surface-state" title={state} aria-hidden="true">
                {stateGlyph(state)}
              </span>
              <span className="sr-only">{state}</span>
              <span className="task-row-main">
                <strong>{id}</strong>
                <span>{short(row.text || 'Untitled task', 180)}</span>
              </span>
              <span className="task-row-meta">
                {priority && (
                  <b className={`priority-${priority}`}>{priority}</b>
                )}
                {dependencies.length > 0 && (
                  <small title={`Depends on ${dependencies.join(', ')}`}>
                    ↳ {dependencies.join(', ')}
                  </small>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </WorkSurface>
  );
}

function surfaceForRenderer(
  input: unknown,
  context: DashboardRendererContext | undefined,
  rendererId: string,
): ExtensionSurface {
  return {
    id: context?.surfaceId ?? rendererId,
    rendererId: context?.rendererId ?? rendererId,
    ...(context?.placement === undefined
      ? {}
      : { placement: context.placement }),
    viewModel: input,
  };
}

export function renderDelegateSurface(
  input: unknown,
  context?: DashboardRendererContext,
): ReactNode {
  return (
    <DelegateSurface
      surface={surfaceForRenderer(input, context, 'delegate.status')}
      pausedAt={context?.pausedAt}
    />
  );
}

export function renderTasksSurface(
  input: unknown,
  context?: DashboardRendererContext,
): ReactNode {
  return (
    <TasksSurface
      surface={surfaceForRenderer(input, context, 'tasks.current')}
      paused={context?.pausedAt !== undefined}
    />
  );
}
