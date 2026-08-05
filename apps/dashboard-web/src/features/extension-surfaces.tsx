import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMemo, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';

/** The bridge adds these fields independently of the core runtime contract. */
export type LiveExtensionSurface = {
  id: string;
  rendererId: string;
  viewModel: unknown;
  placement?: string;
};

type RuntimeWithSurfaces = RuntimeSnapshot & {
  extensionSurfaces?: readonly LiveExtensionSurface[];
};

type SurfacePlacement = 'main' | 'composer';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function short(value: string, max = 180): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function list(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function surfacePlacement(surface: LiveExtensionSurface): SurfacePlacement {
  const placement = surface.placement?.toLowerCase();
  return placement === 'composer' || placement === 'above-composer'
    ? 'composer'
    : 'main';
}

export function runtimeExtensionSurfaces(
  runtime: RuntimeSnapshot | undefined,
): readonly LiveExtensionSurface[] {
  const surfaces = (runtime as RuntimeWithSurfaces | undefined)
    ?.extensionSurfaces;
  if (!Array.isArray(surfaces)) return [];
  return surfaces.filter((surface): surface is LiveExtensionSurface =>
    Boolean(
      surface &&
        typeof surface === 'object' &&
        typeof surface.id === 'string' &&
        surface.id.length > 0 &&
        typeof surface.rendererId === 'string' &&
        surface.rendererId.length > 0,
    ),
  );
}

function stateLabel(value: unknown): string {
  const state = text(value, 'unknown').toLowerCase();
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

function surfaceModelTitle(model: unknown, fallback: string): string {
  const record = asRecord(model);
  return short(text(record?.title) || text(record?.label) || fallback, 90);
}

function delegateRows(model: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(model)) return list(model);
  const record = asRecord(model);
  if (!record) return [];
  return list(
    record.statuses ?? record.delegates ?? record.runs ?? record.items,
  );
}

function delegateStats(rows: readonly Record<string, unknown>[]) {
  return {
    running: rows.filter(
      (row) => stateLabel(row.state ?? row.status) === 'running',
    ).length,
    queued: rows.filter(
      (row) => stateLabel(row.state ?? row.status) === 'queued',
    ).length,
    done: rows.filter((row) => stateLabel(row.state ?? row.status) === 'done')
      .length,
    failed: rows.filter((row) =>
      ['failed', 'blocked'].includes(stateLabel(row.state ?? row.status)),
    ).length,
  };
}

function DelegateSurface({ surface }: { surface: LiveExtensionSurface }) {
  const rows = delegateRows(surface.viewModel);
  const stats = delegateStats(rows);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const title = surfaceModelTitle(surface.viewModel, 'Delegate status');
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return (
    <article className="extension-surface surface-delegate" aria-label={title}>
      <header className="surface-header">
        <div>
          <p className="eyebrow">Delegates</p>
          <h3>{title}</h3>
        </div>
        <span className="surface-count">
          {stats.running
            ? `${stats.running} running`
            : `${rows.length} tracked`}
        </span>
      </header>
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
      <div className="delegate-rows">
        {rows.slice(0, 12).map((row, index) => {
          const id = text(row.id, `delegate-${index}`);
          const state = stateLabel(row.state ?? row.status);
          const activity = asRecord(row.activity);
          const activityLabel = short(
            text(activity?.latestText) ||
              text(activity?.label) ||
              (state === 'queued' ? 'waiting for a slot' : 'starting'),
            140,
          );
          const name = short(text(row.name, 'Subagent'), 70);
          const route = text(row.route) || text(asRecord(row.routing)?.route);
          const context = text(row.context);
          const elapsedText = elapsed(
            row.startedAt ?? row.createdAt,
            row.finishedAt,
          );
          const isExpanded = expanded.has(id);
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
                  <span>
                    {route || context || row.allowWrites === true
                      ? [route, context, row.allowWrites === true ? 'rw' : 'ro']
                          .filter(Boolean)
                          .join(' · ')
                      : 'Details will appear as the delegate reports progress.'}
                  </span>
                  {text(row.task) && <p>{short(text(row.task), 360)}</p>}
                  {Array.isArray(row.scope) && row.scope.length > 0 && (
                    <small>
                      scope: {row.scope.slice(0, 5).map(String).join(', ')}
                    </small>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {rows.length > 12 && (
        <small className="surface-overflow">
          +{rows.length - 12} more delegates
        </small>
      )}
    </article>
  );
}

function taskRows(model: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(model)) return list(model);
  const record = asRecord(model);
  return record ? list(record.tasks ?? record.items) : [];
}

function taskDependencies(row: Record<string, unknown>): string[] {
  const value = row.dependsOn ?? row.depends_on ?? row.dependencies;
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 6)
    : [];
}

function TasksSurface({ surface }: { surface: LiveExtensionSurface }) {
  const rows = taskRows(surface.viewModel);
  const record = asRecord(surface.viewModel);
  const completed = rows.filter(
    (row) => stateLabel(row.status) === 'done',
  ).length;
  const total = rows.length;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const title = surfaceModelTitle(surface.viewModel, 'Tasks');
  const activeCount = asRecord(record?.stats)?.active;
  const countLabel =
    typeof activeCount === 'number'
      ? `${activeCount} active`
      : `${completed}/${total} done`;
  return (
    <article className="extension-surface surface-tasks" aria-label={title}>
      <header className="surface-header">
        <div>
          <p className="eyebrow">Tasks</p>
          <h3>{title}</h3>
        </div>
        <span className="surface-count">{short(countLabel, 40)}</span>
      </header>
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
      <div className="task-rows">
        {rows.slice(0, 10).map((row, index) => {
          const state = stateLabel(row.status);
          const id = text(row.id, `task-${index}`);
          const priority = text(row.priority);
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
                <span>{short(text(row.text, 'Untitled task'), 180)}</span>
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
      {rows.length > 10 && (
        <small className="surface-overflow">
          +{rows.length - 10} more tasks
        </small>
      )}
    </article>
  );
}

function UnknownSurface({ surface }: { surface: LiveExtensionSurface }) {
  let payload = '[unavailable surface data]';
  try {
    payload = JSON.stringify(surface.viewModel, null, 2) ?? payload;
  } catch {
    // Untrusted extension payloads must never break the session view.
  }
  return (
    <details className="extension-surface surface-fallback">
      <summary>Extension surface · {surface.rendererId}</summary>
      <pre>{payload.slice(0, 12_000)}</pre>
    </details>
  );
}

export function renderLiveExtensionSurface(surface: LiveExtensionSurface) {
  const rendererId = surface.rendererId.toLowerCase();
  if (
    rendererId === 'delegate.status' ||
    rendererId.endsWith('.delegate.status')
  )
    return <DelegateSurface surface={surface} />;
  if (
    rendererId === 'tasks.current' ||
    rendererId.endsWith('.tasks.current') ||
    rendererId === 'tasks.tasks' ||
    rendererId.endsWith('.tasks.tasks')
  )
    return <TasksSurface surface={surface} />;
  return <UnknownSurface surface={surface} />;
}

export function ExtensionSurfaceStack({
  runtime,
  placement = 'main',
}: {
  runtime: RuntimeSnapshot | undefined;
  placement?: SurfacePlacement;
}) {
  const surfaces = useMemo(
    () =>
      runtimeExtensionSurfaces(runtime).filter(
        (surface) => surfacePlacement(surface) === placement,
      ),
    [runtime, placement],
  );
  if (!surfaces.length) return null;
  return (
    <section
      className="extension-surfaces"
      aria-label="Live extension surfaces"
    >
      {surfaces.map((surface) => (
        <div className="extension-surface-slot" key={surface.id}>
          {renderLiveExtensionSurface(surface)}
        </div>
      ))}
    </section>
  );
}
