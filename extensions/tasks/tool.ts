import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { ACTION_GLYPH, TOOL } from './constants';
import { TODO_SNAPSHOT_TYPE, transformTodoContext } from './context';
import { mutate, mutateBatch } from './core';
import { dashboard, turnSnapshotText } from './format';
import { normalizeId } from './ids';
import { stats } from './queries';
import { paramsSchema } from './schema';
import {
  captureMutationSnapshot,
  persist,
  restoreMutationSnapshot,
} from './state';
import type { TaskStore } from './store';
import type { ToolDetails } from './types';
import { updateUi } from './ui-widget';

export function registerTodoTool(pi: ExtensionAPI, store: TaskStore): void {
  pi.registerTool<typeof paramsSchema, ToolDetails>({
    name: TOOL,
    label: 'Todo',
    description:
      'Single powerful todo/task tool with dependencies and ordered batch mutations. Keep implementation plans here; update it whenever tasks change.',
    promptSnippet:
      'Manage the branch-local todo list with dependencies and statuses; batch known mutations into one call',
    promptGuidelines: [
      "Use todo for real multi-step work only; do not call todo for trivial one-shot questions or just to restate the user's request.",
      'Before each todo call, group every mutation you can already determine without inspecting an intermediate result into one batch call. Do not make consecutive todo calls when one ordered batch would suffice (for example, done T1 then start T2). Use replace only when rewriting the complete task set.',
      'Use separate todo calls when a later mutation needs an ID or other result from the earlier call, or when you must inspect the resulting state before deciding it.',
      'Use todo start/done/block/drop at meaningful state changes; avoid list unless the replay/widget is insufficient or the user asks.',
      'When adding dependencies, make depends_on point to prerequisite task ids; keep task text short and put context in notes.',
    ],
    parameters: paramsSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      store.lastCtx = ctx;
      const snapshot = captureMutationSnapshot(store);
      const result =
        params.action === 'batch'
          ? mutateBatch(store, params.operations ?? [])
          : mutate(store, params.action, params);
      if (result.error) throw new Error(result.message);
      try {
        updateUi(store, ctx);
        if (result.changed) persist(store, pi);
      } catch (error) {
        restoreMutationSnapshot(store, snapshot);
        try {
          updateUi(store, ctx);
        } catch {
          // Preserve the original persistence/UI failure.
        }
        throw error;
      }

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

export function registerTodoContext(pi: ExtensionAPI, store: TaskStore): void {
  let needsRecovery = false;

  pi.on('session_start', () => {
    needsRecovery = false;
  });
  pi.on('session_compact', () => {
    needsRecovery = true;
  });
  pi.on('session_tree', () => {
    needsRecovery = true;
  });
  pi.on('before_agent_start', () => {
    needsRecovery = false;
    return {
      message: {
        customType: TODO_SNAPSHOT_TYPE,
        content: turnSnapshotText(store),
        display: false,
      },
    };
  });
  pi.on('context', (event) => ({
    messages: transformTodoContext(
      event.messages,
      turnSnapshotText(store),
      Date.now(),
      needsRecovery,
    ),
  }));
}
