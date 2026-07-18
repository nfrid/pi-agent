import type { TaskStore } from './store';
import type { Task } from './types';

export function unfinished(task: Task): boolean {
  return task.status !== 'done' && task.status !== 'dropped';
}

export function missingDeps(store: TaskStore, task: Task): string[] {
  return task.dependsOn.filter((id) => {
    const dep = store.state.tasks.find((candidate) => candidate.id === id);
    return dep?.status !== 'done';
  });
}

export function readyTasks(store: TaskStore): Task[] {
  return store.state.tasks.filter(
    (task) => task.status === 'todo' && missingDeps(store, task).length === 0,
  );
}

export function blockedTasks(store: TaskStore): Task[] {
  return store.state.tasks.filter(
    (task) =>
      unfinished(task) &&
      (task.status === 'blocked' || missingDeps(store, task).length > 0),
  );
}

export function stats(store: TaskStore) {
  const tasks = store.state.tasks;
  const active = tasks.filter(unfinished);
  return {
    total: tasks.length,
    active: active.length,
    done: tasks.filter((task) => task.status === 'done').length,
    blocked: blockedTasks(store).length,
    ready: readyTasks(store).length,
  };
}
