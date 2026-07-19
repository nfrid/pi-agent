import { StringEnum } from '@earendil-works/pi-ai';
import { type Static, Type } from 'typebox';

const statusSchema = () =>
  StringEnum(['todo', 'doing', 'blocked', 'done', 'dropped'] as const);
const prioritySchema = () =>
  StringEnum(['low', 'normal', 'high', 'urgent'] as const);

const taskSchema = Type.Object(
  {
    id: Type.String({
      description: 'Stable task id, e.g. T1. Required for replace.',
    }),
    text: Type.String(),
    status: Type.Optional(statusSchema()),
    depends_on: Type.Optional(Type.Array(Type.String())),
    priority: Type.Optional(prioritySchema()),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const operationProperties = {
  action: StringEnum([
    'list',
    'add',
    'update',
    'start',
    'done',
    'block',
    'drop',
    'remove',
    'clear_done',
    'replace',
  ] as const),
  id: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  status: Type.Optional(statusSchema()),
  depends_on: Type.Optional(Type.Array(Type.String())),
  priority: Type.Optional(prioritySchema()),
  notes: Type.Optional(Type.String()),
  include_done: Type.Optional(Type.Boolean()),
  tasks: Type.Optional(Type.Array(taskSchema)),
};

/** Compact validated batch member; nested batch and unknown fields are invalid. */
export const operationSchema = Type.Object(operationProperties, {
  additionalProperties: false,
});

export const paramsSchema = Type.Object({
  action: StringEnum([
    'list',
    'add',
    'update',
    'start',
    'done',
    'block',
    'drop',
    'remove',
    'clear_done',
    'replace',
    'batch',
  ] as const),
  id: Type.Optional(
    Type.String({
      description: 'Task id for update/start/done/block/drop/remove.',
    }),
  ),
  text: Type.Optional(
    Type.String({ description: 'Task text for add/update.' }),
  ),
  status: Type.Optional(statusSchema()),
  depends_on: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Task ids this task depends on.',
    }),
  ),
  priority: Type.Optional(prioritySchema()),
  notes: Type.Optional(
    Type.String({ description: 'Extra context or block reason.' }),
  ),
  include_done: Type.Optional(
    Type.Boolean({ description: 'For list: include done/dropped tasks.' }),
  ),
  tasks: Type.Optional(
    Type.Array(taskSchema, {
      description: 'For replace: complete desired task set.',
    }),
  ),
  operations: Type.Optional(
    Type.Array(operationSchema, {
      description:
        'For batch: ordered non-batch todo operations. Example: [{"action":"done","id":"T1"},{"action":"start","id":"T2"}].',
    }),
  ),
});

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

export type Params = Static<typeof paramsSchema>;
export type Action = Params['action'];

export type TaskStats = {
  total: number;
  active: number;
  done: number;
  blocked: number;
  ready: number;
};

export type ToolDetails = {
  action: Action;
  changed: boolean;
  message: string;
  stats: TaskStats;
  error?: string;
};

export type TodoUiAction =
  | { kind: 'close' }
  | { kind: 'add' }
  | { kind: 'edit'; id: string }
  | { kind: 'notes'; id: string }
  | { kind: 'deps'; id: string }
  | { kind: 'priority'; id: string }
  | { kind: 'status'; id: string; status: Status }
  | { kind: 'remove'; id: string }
  | { kind: 'clear_done' };

export const EXT = 'lean-todo';
export const TOOL = 'todo';
export const LEGACY_TODO_SNAPSHOT_TYPE = 'lean-todo-replay-v2';
export const LEGACY_TODO_REPLAY_TYPE = 'lean-todo-replay';
export const MAX_TODO_CONTEXT_CHARS = 12_000;
export const MAX_WIDGET_LINES = 12;
export const MAX_RENDER_ITEMS = 14;

export const STATUS_GLYPH: Record<Status, string> = {
  todo: '○',
  doing: '◐',
  blocked: '!',
  done: '✓',
  dropped: '⊘',
};

export const ACTION_GLYPH: Record<Action, string> = {
  list: '☰',
  add: '+',
  update: '→',
  start: '◐',
  done: '✓',
  block: '!',
  drop: '⊘',
  remove: '×',
  clear_done: '∅',
  replace: '⇄',
  batch: '⋯',
};
