import type { Theme } from '@earendil-works/pi-coding-agent';
import { missingDeps, readyTasks, stats, unfinished } from './domain';
import {
  MAX_TODO_CONTEXT_CHARS,
  MAX_TODO_DEPENDENCIES,
  MAX_TODO_FIELD_CHARS,
  STATUS_GLYPH,
  type Task,
} from './model';
import type { TaskStore } from './store';

export function statusColor(
  task: Task,
): 'dim' | 'text' | 'accent' | 'warning' | 'success' | 'muted' {
  if (task.status === 'blocked') return 'warning';
  if (task.status === 'doing') return 'accent';
  if (task.status === 'done') return 'success';
  if (task.status === 'dropped') return 'muted';
  return 'text';
}

function boundedInline(value: string, maxChars = MAX_TODO_FIELD_CHARS): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maxChars
    ? compact
    : `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

function boundedDependencies(task: Task): string {
  const shown = task.dependsOn
    .slice(0, MAX_TODO_DEPENDENCIES)
    .map((dependency) => boundedInline(dependency, 64));
  const omitted = task.dependsOn.length - shown.length;
  if (omitted > 0) shown.push(`…+${omitted} more`);
  return shown.join(',');
}

export function formatTask(task: Task, includeDeps = true): string {
  const deps =
    includeDeps && task.dependsOn.length
      ? ` deps=[${boundedDependencies(task)}]`
      : '';
  const priority =
    task.priority && task.priority !== 'normal' ? ` !${task.priority}` : '';
  const note = task.notes
    ? ` — ${boundedInline(task.notes, MAX_TODO_FIELD_CHARS)}`
    : '';
  return `${boundedInline(task.id, 64)} [${task.status}]${priority}${deps} ${boundedInline(task.text)}${note}`;
}

export function formatVisualTask(
  task: Task,
  theme: Theme,
  opts: { showId?: boolean; showNotes?: boolean } = {},
): string {
  const glyph = theme.fg(statusColor(task), STATUS_GLYPH[task.status]);
  const id = opts.showId === false ? '' : ` ${theme.fg('accent', task.id)}`;
  let text = theme.fg(
    task.status === 'done' || task.status === 'dropped' ? 'dim' : 'text',
    task.text,
  );
  if (task.status === 'done' || task.status === 'dropped')
    text = theme.strikethrough(text);
  const deps = task.dependsOn.length
    ? ` ${theme.fg('dim', `⛓ ${task.dependsOn.join(',')}`)}`
    : '';
  const priority =
    task.priority && task.priority !== 'normal'
      ? ` ${theme.fg(task.priority === 'urgent' ? 'error' : 'warning', `!${task.priority}`)}`
      : '';
  const notes =
    opts.showNotes && task.notes
      ? ` ${theme.fg('dim', `— ${task.notes}`)}`
      : '';
  return `${glyph}${id} ${text}${priority}${deps}${notes}`;
}

export function dashboard(
  store: TaskStore,
  includeDone = false,
  limit = 40,
  maxChars = Number.POSITIVE_INFINITY,
): string {
  const visible = store.state.tasks.filter(
    (task) => includeDone || unfinished(task),
  );
  if (!visible.length) return 'No active tasks.';
  const ready = new Set(readyTasks(store).map((task) => task.id));
  const lines: string[] = [];
  let omittedByBudget = 0;
  for (const [index, task] of visible.slice(0, limit).entries()) {
    const blockedBy = missingDeps(store, task);
    const suffix = blockedBy.length
      ? ` (waiting on ${blockedBy
          .slice(0, MAX_TODO_DEPENDENCIES)
          .map((id) => boundedInline(id, 64))
          .join(
            ', ',
          )}${blockedBy.length > MAX_TODO_DEPENDENCIES ? `, …+${blockedBy.length - MAX_TODO_DEPENDENCIES} more` : ''})`
      : ready.has(task.id)
        ? ' (ready)'
        : '';
    const line = `- ${formatTask(task)}${suffix}`;
    const current = lines.join('\n');
    const omittedAtBudget = visible.length - index;
    const marker = `- … ${omittedAtBudget} more tasks omitted (todo output capped at ${maxChars} characters; use a narrower task set when exact text is needed)`;
    if (
      Number.isFinite(maxChars) &&
      current.length + (current ? 1 : 0) + line.length + marker.length + 1 >
        maxChars
    ) {
      omittedByBudget = visible.length - index;
      break;
    }
    lines.push(line);
  }
  if (omittedByBudget > 0) {
    lines.push(
      `- … ${omittedByBudget} more tasks omitted (todo output capped at ${maxChars} characters; use a narrower task set when exact text is needed)`,
    );
  } else if (visible.length > limit) {
    lines.push(`- … ${visible.length - limit} more tasks omitted`);
  }
  return lines.join('\n');
}

function boundedTodoText(
  store: TaskStore,
  header: string,
  guidance: string,
): string {
  let text = `${header}\n${guidance}\n${dashboard(store, false, 120, MAX_TODO_CONTEXT_CHARS)}`;
  if (text.length > MAX_TODO_CONTEXT_CHARS)
    text = `${text.slice(0, MAX_TODO_CONTEXT_CHARS)}\n… todo context truncated.`;
  return text;
}

export function todoStateText(store: TaskStore): string {
  const s = stats(store);
  return boundedTodoText(
    store,
    `Current todo state (${s.active} active, ${s.ready} ready, ${s.blocked} blocked, ${s.done} done).`,
    'Update this state with the todo tool instead of free-form planning.',
  );
}

export function turnSnapshotText(store: TaskStore): string {
  const s = stats(store);
  return boundedTodoText(
    store,
    `Todo state at the start of this user turn (${s.active} active, ${s.ready} ready, ${s.blocked} blocked, ${s.done} done).`,
    'Later todo results and newer snapshots replace this.',
  );
}
