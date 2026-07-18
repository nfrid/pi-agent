import { dashboard } from './format';
import { findTask, newId, normalizeId, normalizeIds } from './ids';
import {
  captureMutationSnapshot,
  forgetCompletedHide,
  restoreMutationSnapshot,
} from './state';
import type { TaskStore } from './store';
import type { Action, Params, Task } from './types';
import { validateDependencyGraph, validateDeps } from './validate';

export { stats } from './queries';

export interface MutationResult {
  changed: boolean;
  message: string;
  error?: string;
}

export interface MutationEffects {
  updateUi: () => void;
  persist: () => void;
  updateOnError?: boolean;
}

export function executeMutation(
  store: TaskStore,
  action: Action,
  params: Params,
  effects?: MutationEffects,
): MutationResult {
  const snapshot = captureMutationSnapshot(store);
  const result =
    action === 'batch'
      ? mutateBatchUnsafe(store, params.operations ?? [])
      : mutateUnsafe(store, action, params);
  if (result.error) restoreMutationSnapshot(store, snapshot);
  if (!effects || (result.error && !effects.updateOnError)) return result;

  try {
    effects.updateUi();
    if (!result.error && result.changed) effects.persist();
  } catch (error) {
    restoreMutationSnapshot(store, snapshot);
    try {
      effects.updateUi();
    } catch {
      // Preserve the original persistence/UI failure.
    }
    throw error;
  }
  return result;
}

export function mutate(
  store: TaskStore,
  action: Action,
  params: Params,
): MutationResult {
  return executeMutation(store, action, params);
}

export function mutateBatch(
  store: TaskStore,
  operations: NonNullable<Params['operations']>,
): MutationResult {
  return executeMutation(store, 'batch', { action: 'batch', operations });
}

function mutateBatchUnsafe(
  store: TaskStore,
  operations: NonNullable<Params['operations']>,
): MutationResult {
  if (!operations.length)
    return {
      changed: false,
      message: 'operations are required for batch',
      error: 'operations are required for batch',
    };

  const messages: string[] = [];
  let changed = false;
  for (const operation of operations) {
    const step = mutateUnsafe(store, operation.action, operation);
    messages.push(step.error ? `error: ${step.message}` : step.message);
    if (step.error)
      return {
        changed: false,
        message: messages.join('; '),
        error: step.error,
      };
    changed ||= step.changed;
  }
  return { changed, message: messages.join('; ') };
}

function mutateUnsafe(
  store: TaskStore,
  action: Action,
  params: Params,
): MutationResult {
  const now = Date.now();
  const id = normalizeId(params.id);
  if (action === 'list')
    return {
      changed: false,
      message: dashboard(store, Boolean(params.include_done), 80),
    };
  if (action === 'batch')
    return {
      changed: false,
      message: 'batch is handled by execute()',
      error: 'batch is handled by execute()',
    };

  if (action === 'add') {
    if (!params.text?.trim())
      return {
        changed: false,
        message: 'text is required',
        error: 'text is required',
      };
    const task: Task = {
      id: normalizeId(params.id) ?? newId(store),
      text: params.text.trim(),
      status: params.status ?? 'todo',
      dependsOn: normalizeIds(params.depends_on),
      priority: params.priority ?? 'normal',
      notes: params.notes,
      createdAt: now,
      updatedAt: now,
    };
    if (store.state.tasks.some((existing) => existing.id === task.id))
      return {
        changed: false,
        message: `${task.id} already exists`,
        error: `${task.id} already exists`,
      };
    const depError = validateDeps(store, task.id, task.dependsOn);
    if (depError) return { changed: false, message: depError, error: depError };
    store.state.tasks.push(task);
    return { changed: true, message: `added ${task.id}` };
  }

  if (action === 'replace') {
    const incoming = params.tasks ?? [];
    const seen = new Set<string>();
    const tasks: Task[] = [];
    for (const raw of incoming) {
      const taskId = normalizeId(raw.id);
      if (!taskId)
        return {
          changed: false,
          message: 'every task needs an id',
          error: 'every task needs an id',
        };
      if (seen.has(taskId))
        return {
          changed: false,
          message: `duplicate id ${taskId}`,
          error: `duplicate id ${taskId}`,
        };
      seen.add(taskId);
      tasks.push({
        id: taskId,
        text: raw.text,
        status: raw.status ?? 'todo',
        dependsOn: normalizeIds(raw.depends_on),
        priority: raw.priority ?? 'normal',
        notes: raw.notes,
        createdAt: now,
        updatedAt: now,
      });
    }
    const dependencyError = validateDependencyGraph(tasks);
    if (dependencyError)
      return {
        changed: false,
        message: dependencyError,
        error: dependencyError,
      };
    const state = store.state;
    forgetCompletedHide(
      store,
      tasks.map((task) => task.id),
    );
    state.tasks = tasks;
    state.nextId = 1;
    for (const task of state.tasks) {
      const match = /^T(\d+)$/.exec(task.id);
      if (match) state.nextId = Math.max(state.nextId, Number(match[1]) + 1);
    }
    return { changed: true, message: `replaced with ${tasks.length} tasks` };
  }

  if (action === 'clear_done') {
    const state = store.state;
    const before = state.tasks.length;
    const removed = state.tasks
      .filter((task) => task.status === 'done' || task.status === 'dropped')
      .map((task) => task.id);
    state.tasks = state.tasks.filter(
      (task) => task.status !== 'done' && task.status !== 'dropped',
    );
    forgetCompletedHide(store, removed);
    return {
      changed: before !== state.tasks.length,
      message: `cleared ${before - state.tasks.length} completed/dropped tasks`,
    };
  }

  const task = findTask(store, id);
  if (!task)
    return {
      changed: false,
      message: `unknown task ${id ?? ''}`.trim(),
      error: `unknown task ${id ?? ''}`.trim(),
    };

  if (action === 'remove') {
    const dependents = store.state.tasks
      .filter((candidate) => candidate.dependsOn.includes(task.id))
      .map((candidate) => candidate.id);
    if (dependents.length)
      return {
        changed: false,
        message: `${task.id} is depended on by ${dependents.join(', ')}; drop it instead or update dependents first`,
        error: 'task has dependents',
      };
    store.state.tasks = store.state.tasks.filter(
      (candidate) => candidate.id !== task.id,
    );
    forgetCompletedHide(store, [task.id]);
    return { changed: true, message: `removed ${task.id}` };
  }

  if (action === 'drop') {
    forgetCompletedHide(store, [task.id]);
    task.status = 'dropped';
  } else if (action === 'done') {
    forgetCompletedHide(store, [task.id]);
    task.status = 'done';
  } else if (action === 'start') {
    forgetCompletedHide(store, [task.id]);
    task.status = 'doing';
  } else if (action === 'block') {
    task.status = 'blocked';
    if (params.notes) task.notes = params.notes;
  } else if (action === 'update') {
    if (params.text !== undefined) task.text = params.text;
    if (params.status !== undefined) {
      forgetCompletedHide(store, [task.id]);
      task.status = params.status;
    }
    if (params.priority !== undefined) task.priority = params.priority;
    if (params.notes !== undefined) task.notes = params.notes;
    if (params.depends_on !== undefined) {
      const deps = normalizeIds(params.depends_on);
      const depError = validateDeps(store, task.id, deps);
      if (depError)
        return { changed: false, message: depError, error: depError };
      task.dependsOn = deps;
    }
  }
  task.updatedAt = now;
  return { changed: true, message: `${action} ${task.id}` };
}
