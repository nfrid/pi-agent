import { normalizeId } from './normalize';
import { getState } from './state';
import type { Task } from './types';

export { normalizeId, normalizeIds } from './normalize';

export function newId(): string {
  const state = getState();
  while (state.tasks.some((task) => task.id === `T${state.nextId}`))
    state.nextId++;
  return `T${state.nextId++}`;
}

export function findTask(id: string | undefined): Task | undefined {
  const normalized = normalizeId(id);
  return normalized
    ? getState().tasks.find((task) => task.id === normalized)
    : undefined;
}
