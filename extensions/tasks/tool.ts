import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { loadGuidelines } from '../shared/instructions';
import { stats } from './domain';
import {
  MAX_TODO_RESULT_CHARS,
  type MutationParams,
  TOOL_GLYPH,
  type ToolDetails,
  type ToolName,
  todoListParamsSchema,
  todoRemoveParamsSchema,
  todoUpdateParamsSchema,
} from './model';
import { applyMutation, type MutationResult } from './mutations';
import type { TaskStore } from './store';

const LIST_DESCRIPTION =
  'Read-only session todo list. Optionally include done and dropped tasks with include_done.';
const UPDATE_DESCRIPTION =
  'Atomically upsert session todo tasks by stable caller id. New tasks require text and default to todo; existing tasks update only supplied fields. Forward dependency references within changes are allowed, while dependency errors and cycles reject the whole request.';
const REMOVE_DESCRIPTION =
  'Remove session todo tasks by stable caller id. Rejects removal when a retained task depends on any requested id.';
const TODO_RESULT_TRUNCATION_MARKER =
  '\n… todo output truncated; use todo_list after narrowing the active set.';

function boundedResultText(text: string): string {
  if (text.length <= MAX_TODO_RESULT_CHARS) return text;
  const budget = Math.max(
    0,
    MAX_TODO_RESULT_CHARS - TODO_RESULT_TRUNCATION_MARKER.length,
  );
  return `${text.slice(0, budget)}${TODO_RESULT_TRUNCATION_MARKER}`;
}

function executeTodo(
  tool: ToolName,
  params: MutationParams,
  pi: ExtensionAPI,
  store: TaskStore,
  ctx: ExtensionContext,
): { message: string; result: MutationResult } {
  store.lastCtx = ctx;
  const result = applyMutation(store, pi, ctx, tool, params, {
    updateOnError: false,
  });
  return { result, message: boundedResultText(result.message) };
}

function renderCall(
  tool: ToolName,
  args: Record<string, unknown>,
  theme: Theme,
): Text {
  const glyph = TOOL_GLYPH[tool];
  let suffix = '';
  if (tool === 'todo_update') {
    const changes = args.changes;
    const first = Array.isArray(changes) ? changes[0] : undefined;
    const id =
      first && typeof first === 'object' && 'id' in first
        ? String(first.id)
        : undefined;
    const text =
      first && typeof first === 'object' && 'text' in first
        ? String(first.text)
        : undefined;
    if (id) suffix += ` ${theme.fg('accent', id)}`;
    if (text)
      suffix += ` ${theme.fg('dim', truncateToWidth(JSON.stringify(text), 48, '…'))}`;
    if (Array.isArray(changes) && changes.length > 1)
      suffix += ` ${theme.fg('dim', `${changes.length} changes`)}`;
  } else if (tool === 'todo_remove') {
    const ids = args.ids;
    if (Array.isArray(ids)) suffix = ` ${theme.fg('dim', `${ids.length} ids`)}`;
  } else if (args.include_done) {
    suffix = ` ${theme.fg('dim', 'including done')}`;
  }
  return new Text(
    `${theme.fg('toolTitle', theme.bold(`${tool} `))}${theme.fg('muted', glyph)}${suffix}`,
    0,
    0,
  );
}

function renderResult(result: { details?: ToolDetails }, theme: Theme): Text {
  const details = result.details;
  if (!details) return new Text('', 0, 0);
  if (details.error)
    return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);
  const glyph = details.changed ? '✓' : '•';
  const color = details.changed ? 'success' : 'muted';
  return new Text(
    theme.fg(color, `${glyph} ${details.message}`) +
      theme.fg(
        'dim',
        ` (${details.stats.active} active, ${details.stats.ready} ready)`,
      ),
    0,
    0,
  );
}

export function registerTodoTool(pi: ExtensionAPI, store: TaskStore): void {
  pi.registerTool<typeof todoListParamsSchema, ToolDetails>({
    name: 'todo_list',
    label: 'Todo List',
    description: LIST_DESCRIPTION,
    promptSnippet: 'List current session todo tasks and their dependency state',
    parameters: todoListParamsSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { result, message } = executeTodo(
        'todo_list',
        params,
        pi,
        store,
        ctx,
      );
      if (result.error) throw new Error(message);
      return {
        content: [{ type: 'text', text: message }],
        details: {
          tool: 'todo_list',
          changed: result.changed,
          message,
          stats: stats(store),
        },
      };
    },
    renderCall(args, theme) {
      return renderCall('todo_list', args as Record<string, unknown>, theme);
    },
    renderResult(result, _options, theme) {
      return renderResult(result, theme);
    },
  });

  pi.registerTool<typeof todoUpdateParamsSchema, ToolDetails>({
    name: 'todo_update',
    label: 'Todo Update',
    description: UPDATE_DESCRIPTION,
    promptSnippet: 'Create or update todo tasks atomically by stable caller id',
    promptGuidelines: loadGuidelines('instructions.md', __dirname),
    parameters: todoUpdateParamsSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { result, message } = executeTodo(
        'todo_update',
        params,
        pi,
        store,
        ctx,
      );
      if (result.error) throw new Error(message);
      return {
        content: [{ type: 'text', text: message }],
        details: {
          tool: 'todo_update',
          changed: result.changed,
          message,
          stats: stats(store),
        },
      };
    },
    renderCall(args, theme) {
      return renderCall('todo_update', args as Record<string, unknown>, theme);
    },
    renderResult(result, _options, theme) {
      return renderResult(result, theme);
    },
  });

  pi.registerTool<typeof todoRemoveParamsSchema, ToolDetails>({
    name: 'todo_remove',
    label: 'Todo Remove',
    description: REMOVE_DESCRIPTION,
    promptSnippet: 'Remove todo tasks by stable caller id',
    parameters: todoRemoveParamsSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { result, message } = executeTodo(
        'todo_remove',
        params,
        pi,
        store,
        ctx,
      );
      if (result.error) throw new Error(message);
      return {
        content: [{ type: 'text', text: message }],
        details: {
          tool: 'todo_remove',
          changed: result.changed,
          message,
          stats: stats(store),
        },
      };
    },
    renderCall(args, theme) {
      return renderCall('todo_remove', args as Record<string, unknown>, theme);
    },
    renderResult(result, _options, theme) {
      return renderResult(result, theme);
    },
  });
}
