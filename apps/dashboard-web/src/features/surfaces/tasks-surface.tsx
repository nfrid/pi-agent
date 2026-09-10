import type {
  ExtensionSurface,
  TaskStateViewModel,
  TaskSurfaceTask,
} from '@pi-dashboard/extension-contributions';
import { useState } from 'react';
import {
  surfaceStateClass,
  surfaceStateLabel,
  surfaceText,
} from '../delegate/surface-state';
import { stateGlyph } from './state-glyphs';
import { WorkSurface } from './work-surface';

function taskRows(model: TaskStateViewModel): readonly TaskSurfaceTask[] {
  return model.tasks;
}

function taskPriority(row: TaskSurfaceTask): number {
  const state = surfaceStateLabel(row.status);
  if (state === 'running') return 0;
  if (state === 'queued') return 1;
  if (state === 'blocked') return 2;
  return 3;
}

/** Keep the compact panel useful without changing the authoritative task order. */
export function taskPreviewRows(
  rows: readonly TaskSurfaceTask[],
): readonly TaskSurfaceTask[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => taskPriority(row) < 3)
    .sort(
      (left, right) =>
        taskPriority(left.row) - taskPriority(right.row) ||
        left.index - right.index,
    )
    .slice(0, 3)
    .map(({ row }) => row);
}

function taskDependencies(row: TaskSurfaceTask): readonly string[] {
  return row.dependsOn.slice(0, 6);
}

export function TasksSurface({
  surface,
  paused,
  activityPanel = false,
}: {
  surface: ExtensionSurface;
  paused?: boolean;
  activityPanel?: boolean;
}) {
  const model = surface.viewModel as TaskStateViewModel;
  const rows = taskRows(model);
  const completed = model.stats.done;
  const total = model.stats.total;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const title = 'Tasks';
  const blocked = rows.find(
    (row) => surfaceStateLabel(row.status) === 'blocked',
  );
  const running = rows.filter((row) =>
    ['running', 'blocked'].includes(surfaceStateLabel(row.status)),
  );
  const current =
    blocked ??
    running[0] ??
    rows.find((row) => surfaceStateLabel(row.status) === 'queued');
  const launcherTasks = running.length > 0 ? running : current ? [current] : [];
  const previewRows = taskPreviewRows(rows);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const fallbackSummary =
    completed === total
      ? 'All tasks complete'
      : model.stats.active === 0
        ? 'No active tasks'
        : 'Tasks pending';
  const summary = launcherTasks.length ? (
    <span className="surface-launcher-items">
      {launcherTasks.map((row) => {
        const state = surfaceStateLabel(row.status);
        return (
          <span
            className={`surface-launcher-item ${surfaceStateClass(state)}`}
            key={row.id}
          >
            <span className="surface-launcher-item-state" aria-hidden="true">
              {stateGlyph(state)}
            </span>
            <span className="surface-launcher-item-copy">
              <b>{row.id}</b>
              <span>{surfaceText(row.text, 'Untitled task')}</span>
            </span>
          </span>
        );
      })}
    </span>
  ) : (
    fallbackSummary
  );
  const renderTaskRows = (items: readonly TaskSurfaceTask[], compact = false) =>
    items.map((row) => {
      const state = surfaceStateLabel(row.status);
      const id = row.id;
      const priority = row.priority;
      const dependencies = taskDependencies(row);
      return (
        <div
          className={`task-row ${surfaceStateClass(state)}${compact ? ' activity-task-row-compact' : ''}`}
          key={`${surface.id}-${id}`}
        >
          <span className="surface-state" title={state} aria-hidden="true">
            {stateGlyph(state)}
          </span>
          <span className="sr-only">{state}</span>
          <span className="task-row-main">
            {!compact && <strong>{id}</strong>}
            {row.text || 'Untitled task'}
          </span>
          {!compact && (
            <span className="task-row-meta">
              {priority && <b className={`priority-${priority}`}>{priority}</b>}
              {dependencies.length > 0 && (
                <small title={`Depends on ${dependencies.join(', ')}`}>
                  ↳ {dependencies.join(', ')}
                </small>
              )}
            </span>
          )}
        </div>
      );
    });
  if (activityPanel)
    return (
      <section
        className="activity-panel-section"
        aria-label="Tasks"
        tabIndex={-1}
      >
        {previewRows.length === 0 && rows.length > 0 ? (
          <details
            className="activity-panel-completed activity-panel-task-disclosure"
            onToggle={(event) => setPanelExpanded(event.currentTarget.open)}
          >
            <summary aria-label={`${completed} of ${total} tasks complete`}>
              <span>Tasks</span>
              <span>
                {completed}/{total}
              </span>
            </summary>
            {panelExpanded && (
              <div className="activity-panel-rows">{renderTaskRows(rows)}</div>
            )}
          </details>
        ) : (
          <>
            <header className="activity-panel-header">
              <h2>Tasks</h2>
              <span
                role="status"
                aria-label={`${completed} of ${total} tasks complete`}
              >
                {completed}/{total} complete
              </span>
            </header>
            <div className="activity-panel-rows">
              {renderTaskRows(
                panelExpanded ? rows : previewRows,
                !panelExpanded,
              )}
            </div>
            {rows.length > previewRows.length && (
              <button
                type="button"
                className="activity-panel-expand"
                aria-expanded={panelExpanded}
                onClick={() => setPanelExpanded((expanded) => !expanded)}
              >
                {panelExpanded
                  ? 'Show fewer tasks'
                  : `Show all ${rows.length} tasks`}
              </button>
            )}
          </>
        )}
      </section>
    );
  return (
    <WorkSurface
      title={title}
      label="Tasks"
      summary={summary}
      count={
        <span
          role="status"
          className="surface-counter-strip"
          aria-label={`${completed} of ${total} tasks complete`}
        >
          <span
            className={completed === total ? 'surface-done' : 'surface-queued'}
            aria-hidden="true"
          >
            {completed === total ? '✓' : '○'} {completed}/{total}
          </span>
        </span>
      }
      visibleCount={total}
      shortcut={{ code: 'KeyT', alt: true }}
      paused={paused}
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
        {renderTaskRows(rows)}
      </div>
    </WorkSurface>
  );
}
