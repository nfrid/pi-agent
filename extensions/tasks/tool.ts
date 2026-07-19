import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { normalizeId, stats } from './domain';
import { dashboard } from './format';
import { ACTION_GLYPH, paramsSchema, TOOL, type ToolDetails } from './model';
import { applyMutation } from './mutations';
import type { TaskStore } from './store';

export function registerTodoTool(pi: ExtensionAPI, store: TaskStore): void {
  pi.registerTool<typeof paramsSchema, ToolDetails>({
    name: TOOL,
    label: 'Todo',
    description:
      'Branch-local todos with dependencies and batch mutations. Use for multi-step work; update when the plan changes.',
    promptSnippet:
      'Manage the branch-local todo list with dependencies and statuses; batch known mutations into one call',
    promptGuidelines: [
      'Use todo for real multi-step work only; skip it for trivial one-shot questions or restating the request.',
      'Batch known mutations in one call (e.g. done T1 then start T2). Split only when a later step needs a prior result. Use replace only when rewriting the complete task set.',
      'Use start/done/block/drop at meaningful state changes; avoid list unless the widget is insufficient or the user asks.',
      'When adding dependencies, make depends_on point to prerequisite task ids; keep task text short and put context in notes.',
    ],
    parameters: paramsSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      store.lastCtx = ctx;
      const result = applyMutation(store, pi, ctx, params.action, params, {
        updateOnError: false,
      });
      if (result.error) throw new Error(result.message);

      const details: ToolDetails = {
        action: params.action,
        changed: result.changed,
        message: result.message,
        stats: stats(store),
      };
      return {
        content: [
          {
            type: 'text',
            text: `${result.message}\n${dashboard(store, Boolean(params.include_done), 24)}`,
          },
        ],
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
