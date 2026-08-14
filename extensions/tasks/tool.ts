import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { loadGuidelines } from '../shared/instructions';
import { normalizeId, stats } from './domain';
import { dashboard } from './format';
import {
  ACTION_GLYPH,
  MAX_TODO_RESULT_CHARS,
  paramsSchema,
  TOOL,
  type ToolDetails,
} from './model';
import { applyMutation } from './mutations';
import type { TaskStore } from './store';

const DESCRIPTION =
  'Session-scoped todo list with task dependencies, statuses, priorities, notes, and atomic mutations. Actions include list, add, update, start, done, block, drop, remove, clear_done, replace, and batch. Use batch for ordered non-batch mutations; use replace to provide the complete desired task set. Dependencies reference prerequisite task ids, and notes hold extra context or block reasons.';
const TODO_RESULT_TRUNCATION_MARKER =
  '\n… todo output truncated; use todo action:list after narrowing the active set.';

function boundedResultText(text: string): string {
  if (text.length <= MAX_TODO_RESULT_CHARS) return text;
  const budget = Math.max(
    0,
    MAX_TODO_RESULT_CHARS - TODO_RESULT_TRUNCATION_MARKER.length,
  );
  return `${text.slice(0, budget)}${TODO_RESULT_TRUNCATION_MARKER}`;
}

export function registerTodoTool(pi: ExtensionAPI, store: TaskStore): void {
  pi.registerTool<typeof paramsSchema, ToolDetails>({
    name: TOOL,
    label: 'Todo',
    description: DESCRIPTION,
    promptSnippet:
      'Manage the session todo list with dependencies and statuses; batch known mutations into one call',
    promptGuidelines: loadGuidelines('instructions.md', __dirname),
    parameters: paramsSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      store.lastCtx = ctx;
      const result = applyMutation(store, pi, ctx, params.action, params, {
        updateOnError: false,
      });
      const message = boundedResultText(result.message);
      if (result.error) throw new Error(message);

      const details: ToolDetails = {
        action: params.action,
        changed: result.changed,
        message,
        stats: stats(store),
      };
      // The list message already is the dashboard; do not render it twice.
      const text =
        params.action === 'list'
          ? message
          : boundedResultText(
              `${message}\n${dashboard(store, Boolean(params.include_done), 24, MAX_TODO_RESULT_CHARS)}`,
            );
      return {
        content: [{ type: 'text', text }],
        details,
      };
    },
    renderCall(args, theme) {
      const glyph = ACTION_GLYPH[args.action] ?? args.action;
      const id = args.id
        ? ` ${theme.fg('accent', normalizeId(args.id) ?? args.id)}`
        : '';
      const text = args.text
        ? ` ${theme.fg('dim', truncateToWidth(JSON.stringify(args.text), 48, '…'))}`
        : '';
      const count =
        args.action === 'batch' && args.operations
          ? ` ${theme.fg('dim', `${args.operations.length} ops`)}`
          : '';
      return new Text(
        `${theme.fg('toolTitle', theme.bold('todo '))}${theme.fg('muted', glyph)}${id}${text}${count}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
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
    },
  });
}
