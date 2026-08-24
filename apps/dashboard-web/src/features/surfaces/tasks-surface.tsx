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
import { SurfaceStats } from '../surface-drawer';
import { short, stateGlyph } from './state-glyphs';
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
  const current =
    blocked ??
    rows.find((row) => surfaceStateLabel(row.status) === 'running') ??
    rows.find((row) =>
      ['queued', 'todo'].includes(surfaceStateLabel(row.status)),
    );
  const summary = blocked
    ? `Blocked: ${short(surfaceText(blocked.text, 'Task blocked'), 34)}`
    : current
      ? short(surfaceText(current.text, 'Task in progress'), 42)
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
      summaryDetail={
        current ? (
          <small className="surface-summary-detail">
            {blocked
              ? 'Blocked task'
              : `${Math.max(0, total - completed)} remaining`}
          </small>
        ) : undefined
      }
      count={
        <span
          role="status"
          className="surface-counter-strip"
          aria-label={`${completed} of ${total} tasks complete`}
        >
          <span className="surface-done" aria-hidden="true">
            ✓ {completed}/{total}
          </span>
        </span>
      }
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
