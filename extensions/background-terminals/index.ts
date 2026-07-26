import type {
  ExtensionAPI,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { defineExtension } from '../shared/runtime/extension';
import { createManagedWidget } from '../shared/ui/widget';
import { registerBackgroundCommands } from './commands';
import { formatCompletion } from './format';
import { BackgroundManager, type BackgroundSnapshot } from './manager';
import { registerBackgroundMessageRenderer } from './renderers';
import { RESULT_MESSAGE_TYPE, WIDGET_KEY } from './schema';
import { registerBackgroundTool } from './tool';

export default defineExtension(
  'background-terminals',
  (pi: ExtensionAPI): void => {
    let manager: BackgroundManager | undefined;
    let ui: ExtensionUIContext | undefined;

    const widget = createManagedWidget({
      key: WIDGET_KEY,
      isActive: () => (manager?.runningCount ?? 0) > 0,
      render: (width, theme) => {
        const count = manager?.runningCount ?? 0;
        const line =
          theme.fg('warning', '■ ') +
          theme.fg(
            'text',
            `${count} background process${count === 1 ? '' : 'es'} running`,
          ) +
          theme.fg('dim', ' · ') +
          theme.fg('accent', '/ps');
        return [truncateToWidth(line, width, '…')];
      },
      onError: (error) =>
        console.error(
          'background-terminals: failed to update the status widget',
          error,
        ),
    });

    const deliverCompletion = (snapshot: BackgroundSnapshot) => {
      try {
        pi.sendMessage(
          {
            customType: RESULT_MESSAGE_TYPE,
            content: formatCompletion(snapshot),
            display: true,
            details: {
              id: snapshot.id,
              title: snapshot.title,
              status: snapshot.status,
              exitCode: snapshot.exitCode,
              signal: snapshot.signal,
            },
          },
          { deliverAs: 'steer', triggerTurn: true },
        );
      } catch (error) {
        console.error(
          'background-terminals: failed to deliver completion',
          error,
        );
      }
    };

    const createManager = () =>
      new BackgroundManager({
        onSettled: deliverCompletion,
        onChange: () => widget.sync(),
      });

    const getManager = () => {
      manager ??= createManager();
      return manager;
    };

    pi.on('session_start', (_event, ctx) => {
      ui = ctx.hasUI ? ctx.ui : undefined;
      manager ??= createManager();
      widget.attach(ui);
    });

    // Dialogs and occasional TUI rebuilds can drop widget components. Reassert
    // the keyed widget at stable agent boundaries even when the count is unchanged.
    pi.on('agent_start', () => widget.reassert());
    pi.on('agent_settled', () => widget.reassert());

    pi.on('session_shutdown', async () => {
      const closing = manager;
      manager = undefined;
      widget.detach();
      ui = undefined;
      await closing?.dispose();
    });

    registerBackgroundTool(pi, getManager);
    registerBackgroundMessageRenderer(pi);
    registerBackgroundCommands(pi, getManager, () => widget.reassert());
  },
);
