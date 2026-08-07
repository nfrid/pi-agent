import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { defineExtension } from '../shared/runtime/extension';
import { getInteractionBroker } from './broker';
import { TOOL_NAME } from './constants';
import { askThroughDialogs } from './dialogs';
import { normalizeChoices, resultText } from './format';
import { ParamsSchema } from './schema';
import type { Answer, UiResult } from './types';
import { createQuestionDialog } from './ui';

// Registered per session rather than at load, because the tool needs a dialog:
// outside an interactive mode it can only throw, and an unusable tool still
// costs its description and guidelines in every prompt.
export default defineExtension('ask-user', (pi: ExtensionAPI) => {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.hasUI) registerAskUserTool(pi);
  });
});

function registerAskUserTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof ParamsSchema, Answer>({
    name: TOOL_NAME,
    label: 'Ask User',
    description:
      'Ask the user a question and wait for their answer. For decisions that are genuinely theirs to make, not for ambiguity you can resolve yourself.',
    promptSnippet:
      'Ask the user a question with optional choices, optional markdown previews, and a custom-answer field',
    promptGuidelines: [
      "Ask only when the answer is the user's to give — a destructive or irreversible step, or a preference the repository cannot settle. Anything you can decide, decide: pick the best reading, say what you assumed, and continue.",
      'When you do ask, ask once and ask narrowly: one concrete question, with the likely answers as choices, and choice.preview when a short code or ASCII comparison decides it.',
    ],
    parameters: ParamsSchema,
    executionMode: 'sequential',

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const mode = 'mode' in ctx ? ctx.mode : 'tui';
      if (mode !== 'tui' && mode !== 'rpc')
        throw new Error('Cannot ask user: interactive TUI is not available.');

      const choices = normalizeChoices(params);
      let cancelLocal: (() => void) | undefined;
      const sessionScopeId = ctx.sessionManager?.getSessionId() ?? 'default';
      const result = await getInteractionBroker(sessionScopeId).request(
        {
          type: 'ask_user',
          question: params.question,
          choices,
          allowCustom: params.allowCustom !== false,
          customLabel: params.customLabel,
        },
        () =>
          mode === 'tui'
            ? ctx.ui.custom<UiResult>((tui, theme, _keybindings, done) => {
                const dialog = createQuestionDialog(
                  params,
                  choices,
                  tui,
                  theme,
                  done,
                );
                cancelLocal = dialog.cancel;
                return dialog;
              })
            : askThroughDialogs(params, choices, ctx.ui),
        mode === 'tui' ? () => cancelLocal?.() : undefined,
        sessionScopeId,
      );

      const details: Answer = result
        ? {
            question: params.question,
            answer: result.answer,
            choiceLabel: result.choiceLabel,
            choiceIndex: result.choiceIndex,
            custom: result.custom,
            cancelled: false,
          }
        : {
            question: params.question,
            answer: null,
            custom: false,
            cancelled: true,
          };

      return {
        content: [{ type: 'text', text: resultText(details) }],
        details,
      };
    },

    renderCall(args, theme) {
      const choices = Array.isArray(args.choices) ? args.choices : [];
      const suffix =
        choices.length > 0
          ? theme.fg('dim', ` (${choices.length} choices)`)
          : theme.fg('dim', ' (free-form)');
      return new Text(
        theme.fg('toolTitle', theme.bold('ask user ')) +
          theme.fg('muted', truncateToWidth(args.question, 72, '…')) +
          suffix,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details;
      if (!details) return new Text('', 0, 0);
      if (details.cancelled)
        return new Text(theme.fg('warning', 'Cancelled'), 0, 0);
      const answer = details.choiceLabel ?? details.answer ?? '';
      const prefix = details.choiceIndex ? `${details.choiceIndex}. ` : '';
      const mode = details.custom ? theme.fg('muted', '(typed) ') : '';
      return new Text(
        theme.fg('success', '✓ ') +
          mode +
          theme.fg('accent', `${prefix}${answer}`),
        0,
        0,
      );
    },
  });
}
