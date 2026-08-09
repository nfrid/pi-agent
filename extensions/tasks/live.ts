import {
  type ExtensionSurface,
  parseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import { Value } from 'typebox/value';
import {
  clearLiveExtensionSurfaces,
  publishLiveExtensionSurfaces,
} from '../shared/runtime/live-surfaces';
import type { SessionScopeId } from '../shared/runtime/scoped-services';
import {
  TASKS_RENDERER_ID,
  TASKS_SURFACE_ID,
  TaskStateViewModelSchema,
} from './contribution';
import { stats } from './domain';
import type { TaskStore } from './store';

export const TASKS_EXTENSION_ID = 'tasks';

function boundedTask(task: TaskStore['state']['tasks'][number]) {
  return {
    id: task.id.slice(0, 256),
    text: task.text.slice(0, 4_000),
    status: task.status,
    dependsOn: task.dependsOn.slice(0, 64).map((id) => id.slice(0, 256)),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.notes === undefined ? {} : { notes: task.notes.slice(0, 10_000) }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function surfaceTasks(store: TaskStore) {
  const tasks = store.state.tasks;
  if (tasks.length <= 128) return tasks;
  return [
    ...tasks.filter((task) => task.status === 'doing'),
    ...tasks.filter((task) => task.status !== 'doing'),
  ].slice(0, 128);
}

export function taskSurface(store: TaskStore): ExtensionSurface {
  const viewModel = {
    version: 1 as const,
    tasks: surfaceTasks(store).map(boundedTask),
    stats: stats(store),
  };
  if (!Value.Check(TaskStateViewModelSchema, viewModel))
    throw new Error('Task state surface is invalid.');
  return parseExtensionSurface({
    id: TASKS_SURFACE_ID,
    rendererId: TASKS_RENDERER_ID,
    placement: 'left-rail',
    viewModel,
  });
}

export function publishTaskSurface(
  store: TaskStore,
  scopeId?: SessionScopeId,
): void {
  publishLiveExtensionSurfaces(
    TASKS_EXTENSION_ID,
    [taskSurface(store)],
    scopeId,
  );
}

export function clearTaskSurface(scopeId?: SessionScopeId): void {
  clearLiveExtensionSurfaces(TASKS_EXTENSION_ID, scopeId);
}
