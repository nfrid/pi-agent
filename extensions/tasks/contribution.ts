import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  tasksRenderer,
} from '@pi-dashboard/extension-contributions';

export type {
  TaskStateViewModel,
  TaskSurfaceTask,
} from '@pi-dashboard/extension-contributions';
export {
  TASKS_RENDERER_ID,
  TASKS_SURFACE_ID,
  TaskStateViewModelSchema,
  TaskSurfaceTaskSchema,
  tasksRenderer,
} from '@pi-dashboard/extension-contributions';

export const TASKS_CAPABILITY_ID = 'tasks.live-state';

export const tasksManifest: ExtensionManifest = {
  id: 'tasks',
  version: '1',
  title: 'Tasks',
  actions: [],
  renderers: [tasksRenderer],
};

export const tasksCapabilitySnapshot = createRuntimeCapabilitySnapshot(
  [tasksManifest],
  [
    {
      id: TASKS_CAPABILITY_ID,
      version: '1',
      available: true,
      summary: 'Live current task state and task statistics.',
    },
  ],
);
