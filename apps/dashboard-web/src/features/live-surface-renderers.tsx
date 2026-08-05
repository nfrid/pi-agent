import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import { type ReactNode, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type {
  DelegateStatus,
  DelegateStatusViewModel,
  DelegateTranscriptEntry,
} from '../../../../extensions/delegate/contribution';
import type {
  TaskStateViewModel,
  TaskSurfaceTask,
} from '../../../../extensions/tasks/contribution';
import { Markdown } from '../Markdown';
import type { DashboardRendererContext } from '../renderer-registry';

function text(value: string | undefined, fallback = ''): string {
  return value?.trim() || fallback;
}

function short(value: string, max = 180): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function stateLabel(value: string): string {
  const state = value.toLowerCase();
  if (state === 'running' || state === 'doing') return 'running';
  if (state === 'queued' || state === 'todo') return 'queued';
  if (state === 'success' || state === 'done' || state === 'completed')
    return 'done';
  if (
    state === 'error' ||
    state === 'failed' ||
    state === 'blocked' ||
    state === 'timed-out'
  )
    return state === 'blocked' ? 'blocked' : 'failed';
  return state;
}

function stateGlyph(state: string): string {
  if (state === 'running') return '●';
  if (state === 'done') return '✓';
  if (state === 'failed' || state === 'blocked') return '!';
  return '○';
}

function stateClass(state: string): string {
  if (state === 'running') return 'surface-running';
  if (state === 'done') return 'surface-done';
  if (state === 'failed' || state === 'blocked') return 'surface-failed';
  return 'surface-queued';
}

function elapsed(start: unknown, finish: unknown): string | undefined {
  if (typeof start !== 'number') return undefined;
  const end = typeof finish === 'number' ? finish : Date.now();
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
    running: rows.filter((row) => stateLabel(row.state) === 'running').length,
    queued: rows.filter((row) => stateLabel(row.state) === 'queued').length,
    done: rows.filter((row) => stateLabel(row.state) === 'done').length,
    failed: rows.filter((row) =>
      ['failed', 'blocked'].includes(stateLabel(row.state)),
    ).length,
  };
}

export function DelegateTranscript({
  entries,
  truncated = false,
}: {
  entries: readonly DelegateTranscriptEntry[];
  truncated?: boolean;
}) {
  return (
    <ol className="delegate-transcript" aria-label="Delegate transcript">
      {entries.map((entry) => {
        const entryId = text(entry.id);
        const entryType = text(entry.type, 'activity');
        const entryText = text(entry.text);
        const entryStatus = text(entry.status);
        const transcriptRun =
          typeof entry.run === 'number' ? entry.run : undefined;
        return (
          <li
            className={`delegate-transcript-entry transcript-${entryType}`}
            key={entryId}
          >
            <header>
              <strong>{text(entry.label, entryType)}</strong>
              <small>
                {[transcriptRun ? `run ${transcriptRun}` : '', entryStatus]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </header>
            {entryText &&
              (entryType === 'tool' ? (
                <pre>{entryText}</pre>
              ) : (
                <Markdown>{entryText}</Markdown>
              ))}
          </li>
        );
      })}
      {truncated && (
        <li className="delegate-transcript-truncated">
          Earlier transcript entries were omitted to keep the live surface
          bounded.
        </li>
      )}
    </ol>
  );
}

function DelegateSurface({ surface }: { surface: ExtensionSurface }) {
  const model = surface.viewModel as DelegateStatusViewModel;
  const rows = delegateRows(model);
  const stats = delegateStats(rows);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const title = 'Delegate status';
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const active = rows.find((row) => stateLabel(row.state) === 'running');
  const summary = active
    ? `● ${short(text(active.name, 'Subagent'), 42)}`
    : stats.failed
      ? `! ${stats.failed} failed`
      : `✓ ${stats.done} done`;
  return (
    <article className="extension-surface surface-delegate" aria-label={title}>
      <AriaButton
        type="button"
        className="surface-header surface-toggle"
        aria-expanded={open}
        onPress={() => setOpen((current) => !current)}
      >
        <span className="surface-title">
          <span className="eyebrow">Delegates</span>
          <strong>{summary}</strong>
        </span>
        <span className="surface-count">
          {stats.running
            ? `${stats.running} running`
            : `${rows.length} tracked`}
        </span>
        <span className="surface-chevron" aria-hidden="true">
          {open ? '⌄' : '›'}
        </span>
      </AriaButton>
      {open && (
        <>
          <div
            className="surface-summary"
            role="status"
            aria-label="Delegate status summary"
          >
            {stats.running > 0 && (
              <span className="surface-running">● {stats.running} active</span>
            )}
            {stats.queued > 0 && <span>○ {stats.queued} queued</span>}
            {stats.done > 0 && (
              <span className="surface-done">✓ {stats.done} done</span>
            )}
            {stats.failed > 0 && (
              <span className="surface-failed">! {stats.failed} failed</span>
            )}
            {!rows.length && (
              <span className="muted">No delegate runs reported.</span>
            )}
          </div>
          <div className="delegate-rows surface-detail-list">
            {rows.map((row) => {
              const id = row.id;
              const state = stateLabel(row.state);
              const activity = row.activity;
              const activityLabel = short(
                activity?.latestText ||
                  activity?.label ||
                  (state === 'queued' ? 'waiting for a slot' : 'starting'),
                140,
              );
              const name = short(row.name, 70);
              const route = row.route ?? '';
              const context = row.context ?? '';
              const elapsedText = elapsed(
                row.startedAt ?? row.createdAt,
                row.finishedAt,
              );
              const isExpanded = expanded.has(id);
              const jobId = row.jobId ?? '';
              const activityType = activity?.type ?? '';
              const activityStatus = activity?.status ?? '';
              const latestText = short(activity?.latestText ?? '', 600);
              const runs = row.runs?.slice(-6) ?? [];
              const transcript = row.transcript ?? [];
              return (
                <div
                  className={`delegate-row ${stateClass(state)}`}
                  key={`${surface.id}-${id}`}
                >
                  <AriaButton
                    type="button"
                    className="delegate-row-toggle"
                    aria-expanded={isExpanded}
                    onPress={() => toggle(id)}
                  >
                    <span className="surface-state" aria-hidden="true">
                      {stateGlyph(state)}
                    </span>
                    <span className="delegate-row-main">
                      <strong>{name}</strong>
                      <small>{activityLabel}</small>
                    </span>
                    <span className="delegate-row-meta">
                      {state}
                      {elapsedText ? ` · ${elapsedText}` : ''}
                    </span>
                    <span className="delegate-row-chevron" aria-hidden="true">
                      {isExpanded ? '⌄' : '›'}
                    </span>
                  </AriaButton>
                  {isExpanded && (
                    <div className="delegate-row-detail">
                      <dl>
                        {route && (
                          <div>
                            <dt>Route</dt>
                            <dd>{route}</dd>
                          </div>
                        )}
                        {context && (
                          <div>
                            <dt>Context</dt>
                            <dd>{context}</dd>
                          </div>
                        )}
                        <div>
                          <dt>Access</dt>
                          <dd>
                            {row.allowWrites === true
                              ? 'read/write'
                              : 'read-only'}
                          </dd>
                        </div>
                        {jobId && (
                          <div>
                            <dt>Job</dt>
                            <dd>{jobId}</dd>
                          </div>
                        )}
                        {(activityType || activityStatus) && (
                          <div>
                            <dt>Activity</dt>
                            <dd>
                              {[activityType, activityStatus]
                                .filter(Boolean)
                                .join(' · ')}
                            </dd>
                          </div>
                        )}
                      </dl>
                      {transcript.length > 0 ? (
                        <DelegateTranscript
                          entries={transcript}
                          truncated={row.transcriptTruncated === true}
                        />
                      ) : (
                        latestText && <p>{latestText}</p>
                      )}
                      {runs.length > 0 && (
                        <ol
                          className="delegate-run-history"
                          aria-label="Run history"
                        >
                          {runs.map((run, runIndex) => {
                            const runState = stateLabel(run.state);
                            const runKey = [
                              id,
                              runState,
                              String(run.startedAt),
                              String(run.finishedAt),
                            ].join('-');
                            return (
                              <li className="delegate-run-item" key={runKey}>
                                <span
                                  className={`surface-state ${stateClass(runState)}`}
                                  aria-hidden="true"
                                >
                                  {stateGlyph(runState)}
                                </span>
                                <span>Run {runIndex + 1}</span>
                                <small>
                                  {runState}
                                  {elapsed(run.startedAt, run.finishedAt)
                                    ? ` · ${elapsed(run.startedAt, run.finishedAt)}`
                                    : ''}
                                </small>
                              </li>
                            );
                          })}
                        </ol>
                      )}
                      {!route &&
                        !context &&
                        !jobId &&
                        !activityType &&
                        !activityStatus &&
                        !latestText &&
                        transcript.length === 0 &&
                        runs.length === 0 && (
                          <span>
                            Waiting for the delegate to report details.
                          </span>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </article>
  );
}

function taskRows(model: TaskStateViewModel): readonly TaskSurfaceTask[] {
  return model.tasks;
}

function taskDependencies(row: TaskSurfaceTask): readonly string[] {
  return row.dependsOn.slice(0, 6);
}

function TasksSurface({ surface }: { surface: ExtensionSurface }) {
  const model = surface.viewModel as TaskStateViewModel;
  const rows = taskRows(model);
  const [open, setOpen] = useState(false);
  const completed = rows.filter(
    (row) => stateLabel(row.status) === 'done',
  ).length;
  const total = rows.length;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const title = 'Tasks';
  const countLabel = `${model.stats.active} active`;
  const current = rows.find((row) => stateLabel(row.status) === 'running');
  const summary = current
    ? `● ${short(text(current.text, 'Task in progress'), 42)}`
    : `${completed}/${total} complete`;
  return (
    <article className="extension-surface surface-tasks" aria-label={title}>
      <AriaButton
        type="button"
        className="surface-header surface-toggle"
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
      >
        <span className="surface-title">
          <span className="eyebrow">Tasks</span>
          <strong>{summary}</strong>
        </span>
        <span className="surface-count">{short(countLabel, 40)}</span>
        <span className="surface-chevron" aria-hidden="true">
          {open ? '⌄' : '›'}
        </span>
      </AriaButton>
      {open && (
        <>
          <div
            className="task-progress"
            role="progressbar"
            aria-label="Task progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <span>
              {completed}/{total} complete
            </span>
            <span className="task-progress-track" aria-hidden="true">
              <i style={{ width: `${progress}%` }} />
            </span>
          </div>
          <div className="task-rows surface-detail-list">
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
                  <span
                    className="surface-state"
                    title={state}
                    aria-hidden="true"
                  >
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
            {!rows.length && <span className="muted">No tasks reported.</span>}
          </div>
        </>
      )}
    </article>
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
    />
  );
}
