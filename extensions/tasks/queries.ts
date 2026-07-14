import { getState } from './state';
import type { Task } from './types';

export function unfinished(task: Task): boolean {
  return task.status !== 'done' && task.status !== 'dropped';
}

export function missingDeps(task: Task): string[] {
  return task.dependsOn.filter((id) => {
    const dep = getState().tasks.find((candidate) => candidate.id === id);
    return dep?.status !== 'done';
  });
}

export function readyTasks(): Task[] {
  return getState().tasks.filter(
    (task) => task.status === 'todo' && missingDeps(task).length === 0,
  );
}

export function blockedTasks(): Task[] {
  return getState().tasks.filter(
    (task) =>
      unfinished(task) &&
      (task.status === 'blocked' || missingDeps(task).length > 0),
  );
}

export function stats() {
  const tasks = getState().tasks;
  const active = tasks.filter(unfinished);
  return {
    total: tasks.length,
    active: active.length,
    done: tasks.filter((task) => task.status === 'done').length,
    blocked: blockedTasks().length,
    ready: readyTasks().length,
  };
}
