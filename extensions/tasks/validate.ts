import { normalizeId } from './normalize';
import type { TaskStore } from './store';
import type { Task } from './types';

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
  const unique = [
    ...new Set(
      deps.map(normalizeId).filter((dep): dep is string => Boolean(dep)),
    ),
  ];
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
