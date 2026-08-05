import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  type RendererDescriptor,
} from '@pi-dashboard/extension-contributions';
import { Type } from 'typebox';

export const TASKS_CAPABILITY_ID = 'tasks.live-state';
export const TASKS_RENDERER_ID = 'tasks.current';
export const TASKS_SURFACE_ID = 'tasks.current';

const TaskStatusSchema = Type.Union([
  Type.Literal('todo'),
  Type.Literal('doing'),
  Type.Literal('blocked'),
  Type.Literal('done'),
  Type.Literal('dropped'),
]);
const TaskPrioritySchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('normal'),
  Type.Literal('high'),
  Type.Literal('urgent'),
]);
export const TaskSurfaceTaskSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    text: Type.String({ maxLength: 4_000 }),
    status: TaskStatusSchema,
    dependsOn: Type.Readonly(
      Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        maxItems: 64,
      }),
    ),
    priority: Type.Optional(TaskPrioritySchema),
    notes: Type.Optional(Type.String({ maxLength: 10_000 })),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
);
const TaskStatsSchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    active: Type.Integer({ minimum: 0 }),
    done: Type.Integer({ minimum: 0 }),
    blocked: Type.Integer({ minimum: 0 }),
    ready: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export const TaskStateViewModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    tasks: Type.Readonly(Type.Array(TaskSurfaceTaskSchema, { maxItems: 128 })),
    stats: TaskStatsSchema,
  },
  { additionalProperties: false },
);

export const tasksRenderer: RendererDescriptor = {
  id: TASKS_RENDERER_ID,
  mode: 'inspector',
  inputSchema: TaskStateViewModelSchema,
  title: 'Tasks',
  summary: 'The current bounded task state and dependency summary.',
};

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
