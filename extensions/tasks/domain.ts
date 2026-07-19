import type { Task, TaskStats } from './model';
import type { TaskStore } from './store';

export function normalizeId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return /^T\d+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

export function normalizeIds(values: readonly unknown[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map(normalizeId).filter((id): id is string => Boolean(id)),
    ),
  ];
}

export function newId(store: TaskStore): string {
  while (store.state.tasks.some((task) => task.id === `T${store.state.nextId}`))
    store.state.nextId++;
  return `T${store.state.nextId++}`;
}

export function findTask(
  store: TaskStore,
  id: string | undefined,
): Task | undefined {
  const normalized = normalizeId(id);
  return normalized
    ? store.state.tasks.find((task) => task.id === normalized)
    : undefined;
}

export function validateDependencyGraph(tasks: Task[]): string | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.dependsOn.includes(task.id)) return 'task cannot depend on itself';
    const missing = task.dependsOn.filter((dep) => !byId.has(dep));
    if (missing.length)
      return `unknown dependencies: ${[...new Set(missing)].join(', ')}`;
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string | undefined => {
    if (visited.has(id)) return undefined;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return `dependency cycle: ${[...path.slice(start), id].join(' -> ')}`;
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      const error = visit(dependency);
      if (error) return error;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };

  for (const task of tasks) {
    const error = visit(task.id);
    if (error) return error;
  }
  return undefined;
}

export function validateDeps(
  store: TaskStore,
  id: string,
  deps: string[],
): string | undefined {
  const unique = normalizeIds(deps);
  const tasks = [
    ...store.state.tasks.filter((task) => task.id !== id),
    {
      id,
      text: '',
      status: 'todo' as const,
      dependsOn: unique,
      priority: 'normal' as const,
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  return validateDependencyGraph(tasks);
}

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

export function stats(store: TaskStore): TaskStats {
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
