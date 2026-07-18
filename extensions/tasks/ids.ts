import { normalizeId } from './normalize';
import type { TaskStore } from './store';
import type { Task } from './types';

export { normalizeId, normalizeIds } from './normalize';

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
