import { StringEnum } from '@earendil-works/pi-ai';
import { type Static, Type } from 'typebox';

const statusSchema = () =>
  StringEnum(['todo', 'doing', 'blocked', 'done', 'dropped'] as const);
const prioritySchema = () =>
  StringEnum(['low', 'normal', 'high', 'urgent'] as const);

export const taskChangeSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      description: 'Stable caller-supplied task id, e.g. T1.',
    }),
    text: Type.Optional(Type.String()),
    status: Type.Optional(statusSchema()),
    depends_on: Type.Optional(Type.Array(Type.String())),
    priority: Type.Optional(prioritySchema()),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const todoListParamsSchema = Type.Object(
  {
    include_done: Type.Optional(
      Type.Boolean({ description: 'Include done and dropped tasks.' }),
    ),
  },
  { additionalProperties: false },
);

export const todoUpdateParamsSchema = Type.Object(
  {
    changes: Type.Array(taskChangeSchema, {
      minItems: 1,
      description:
        'Tasks to create or update. Each change needs a stable id; new tasks also need text. Forward dependency references are allowed within this request.',
    }),
  },
  { additionalProperties: false },
);

export const todoRemoveParamsSchema = Type.Object(
  {
    ids: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: 'Stable task ids to remove.',
    }),
  },
  { additionalProperties: false },
);

export type Status = 'todo' | 'doing' | 'blocked' | 'done' | 'dropped';

export type Task = {
  id: string;
  text: string;
  status: Status;
  dependsOn: string[];
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

export type State = {
  version: 1;
  nextId: number;
  tasks: Task[];
};

export type SnapshotEntry = {
  kind: 'snapshot';
  state: State;
};

export type TodoListParams = Static<typeof todoListParamsSchema>;
export type TodoUpdateParams = Static<typeof todoUpdateParamsSchema>;
export type TodoRemoveParams = Static<typeof todoRemoveParamsSchema>;
export type TaskChange = Static<typeof taskChangeSchema>;
export type ToolName = 'todo_list' | 'todo_update' | 'todo_remove';
export type MutationParams =
  | TodoListParams
  | TodoUpdateParams
  | TodoRemoveParams;

export type TaskStats = {
  total: number;
  active: number;
  done: number;
  blocked: number;
  ready: number;
};

export type ToolDetails = {
  tool: ToolName;
  changed: boolean;
  message: string;
  stats: TaskStats;
  error?: string;
};

export const EXT = 'lean-todo';
/** Legacy tool name retained so old conversation results remain contextualized. */
export const TOOL = 'todo';
export const TODO_TOOL_NAMES = [
  'todo_list',
  'todo_update',
  'todo_remove',
] as const;
export const LEGACY_TODO_SNAPSHOT_TYPE = 'lean-todo-replay-v2';
export const LEGACY_TODO_REPLAY_TYPE = 'lean-todo-replay';
export const MAX_TODO_CONTEXT_CHARS = 12_000;
/** Maximum routine todo tool text; state remains available through later list calls. */
export const MAX_TODO_RESULT_CHARS = 8_000;
/** Keep one task row actionable without allowing a note to dominate context. */
export const MAX_TODO_FIELD_CHARS = 512;
export const MAX_TODO_DEPENDENCIES = 16;
export const MAX_WIDGET_LINES = 12;

export const STATUS_GLYPH: Record<Status, string> = {
  todo: '○',
  doing: '◐',
  blocked: '!',
  done: '✓',
  dropped: '⊘',
};

export const TOOL_GLYPH: Record<ToolName, string> = {
  todo_list: '☰',
  todo_update: '→',
  todo_remove: '×',
};
