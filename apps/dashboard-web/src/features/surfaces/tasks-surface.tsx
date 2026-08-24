import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import type {
  TaskStateViewModel,
  TaskSurfaceTask,
} from '../../../../../extensions/tasks/contribution';
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

function taskDependencies(row: TaskSurfaceTask): readonly string[] {
  return row.dependsOn.slice(0, 6);
}

export function TasksSurface({
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
        {rows.map((row) => {
          const state = surfaceStateLabel(row.status);
          const id = row.id;
          const priority = row.priority;
          const dependencies = taskDependencies(row);
          return (
            <div
              className={`task-row ${surfaceStateClass(state)}`}
              key={`${surface.id}-${id}`}
            >
              <span className="surface-state" title={state} aria-hidden="true">
                {stateGlyph(state)}
              </span>
              <span className="sr-only">{state}</span>
              <span className="task-row-main">
                <strong>{id}</strong>
                {row.text || 'Untitled task'}
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
