import { dashboard } from './format';
import { findTask, newId, normalizeId, normalizeIds } from './ids';
import { forgetCompletedHide, getState } from './state';
import type { Action, Params, Task } from './types';
import { validateDeps } from './validate';

export { stats } from './queries';

export function mutate(
  action: Action,
  params: Params,
): { changed: boolean; message: string; error?: string } {
  const now = Date.now();
  const id = normalizeId(params.id);
  if (action === 'list')
    return {
      changed: false,
      message: dashboard(Boolean(params.include_done), 80),
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
      id: normalizeId(params.id) ?? newId(),
      text: params.text.trim(),
      status: params.status ?? 'todo',
      dependsOn: normalizeIds(params.depends_on),
      priority: params.priority ?? 'normal',
      notes: params.notes,
      createdAt: now,
      updatedAt: now,
    };
    if (getState().tasks.some((existing) => existing.id === task.id))
      return {
        changed: false,
        message: `${task.id} already exists`,
        error: `${task.id} already exists`,
      };
    const depError = validateDeps(task.id, task.dependsOn);
    if (depError) return { changed: false, message: depError, error: depError };
    getState().tasks.push(task);
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
    const ids = new Set(tasks.map((task) => task.id));
    for (const task of tasks) {
      if (task.dependsOn.includes(task.id))
        return {
          changed: false,
          message: `${task.id} depends on itself`,
          error: `${task.id} depends on itself`,
        };
      const missing = task.dependsOn.filter((dep) => !ids.has(dep));
      if (missing.length)
        return {
          changed: false,
          message: `${task.id} has unknown deps ${missing.join(', ')}`,
          error: `${task.id} has unknown deps ${missing.join(', ')}`,
        };
    }
    const state = getState();
    forgetCompletedHide(tasks.map((task) => task.id));
    state.tasks = tasks;
    state.nextId = 1;
    for (const task of state.tasks) {
      const match = /^T(\d+)$/.exec(task.id);
      if (match) state.nextId = Math.max(state.nextId, Number(match[1]) + 1);
    }
    return { changed: true, message: `replaced with ${tasks.length} tasks` };
  }

  if (action === 'clear_done') {
    const state = getState();
    const before = state.tasks.length;
    const removed = state.tasks
      .filter((task) => task.status === 'done' || task.status === 'dropped')
      .map((task) => task.id);
    state.tasks = state.tasks.filter(
      (task) => task.status !== 'done' && task.status !== 'dropped',
    );
    forgetCompletedHide(removed);
    return {
      changed: before !== state.tasks.length,
      message: `cleared ${before - state.tasks.length} completed/dropped tasks`,
    };
  }

  const task = findTask(id);
  if (!task)
    return {
      changed: false,
      message: `unknown task ${id ?? ''}`.trim(),
      error: `unknown task ${id ?? ''}`.trim(),
    };

  if (action === 'remove') {
    const dependents = getState()
      .tasks.filter((candidate) => candidate.dependsOn.includes(task.id))
      .map((candidate) => candidate.id);
    if (dependents.length)
      return {
        changed: false,
        message: `${task.id} is depended on by ${dependents.join(', ')}; drop it instead or update dependents first`,
        error: 'task has dependents',
      };
    getState().tasks = getState().tasks.filter(
      (candidate) => candidate.id !== task.id,
    );
    forgetCompletedHide([task.id]);
    return { changed: true, message: `removed ${task.id}` };
  }

  if (action === 'drop') {
    forgetCompletedHide([task.id]);
    task.status = 'dropped';
  } else if (action === 'done') {
    forgetCompletedHide([task.id]);
    task.status = 'done';
  } else if (action === 'start') {
    forgetCompletedHide([task.id]);
    task.status = 'doing';
  } else if (action === 'block') {
    task.status = 'blocked';
    if (params.notes) task.notes = params.notes;
  } else if (action === 'update') {
    if (params.text !== undefined) task.text = params.text;
    if (params.status !== undefined) {
      forgetCompletedHide([task.id]);
      task.status = params.status;
    }
    if (params.priority !== undefined) task.priority = params.priority;
    if (params.notes !== undefined) task.notes = params.notes;
    if (params.depends_on !== undefined) {
      const deps = normalizeIds(params.depends_on);
      const depError = validateDeps(task.id, deps);
      if (depError)
        return { changed: false, message: depError, error: depError };
      task.dependsOn = deps;
    }
  }
  task.updatedAt = now;
  return { changed: true, message: `${action} ${task.id}` };
}
