import type {
  ExtensionAPI,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { defineExtension } from '../shared/runtime/extension';
import {
  getScopedServices,
  getSessionScopeId,
  releaseScopedServices,
  type ScopedServices,
  type SessionScopeId,
} from '../shared/runtime/scoped-services';
import { createManagedWidget } from '../shared/ui/widget';
import { registerBackgroundCommands } from './commands';
import { exitDescription, formatCompletion, formatDuration } from './format';
import { BackgroundManager, type BackgroundSnapshot } from './manager';
import { registerBackgroundMessageRenderer } from './renderers';
import { RESULT_MESSAGE_TYPE, WIDGET_KEY } from './schema';
import { registerBackgroundTool } from './tool';

export default defineExtension(
  'background-terminals',
  (pi: ExtensionAPI): void => {
    let manager: BackgroundManager | undefined;
    let ui: ExtensionUIContext | undefined;
    let scopeId: SessionScopeId | undefined;
    let scopedServices: ScopedServices | undefined;

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
              duration: formatDuration(snapshot),
              outcome: exitDescription(snapshot),
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

    const createManager = (scope?: SessionScopeId) => {
      const services = getScopedServices(scope);
      scopedServices = services;
      return new BackgroundManager({
        scopeId: services.scopeId,
        pendingProcesses: services.pendingProcesses,
        onSettled: deliverCompletion,
        onChange: () => widget.sync(),
      });
    };

    const getManager = () => {
      manager ??= createManager();
      return manager;
    };

    pi.on('session_start', (_event, ctx) => {
      const nextScope = getSessionScopeId(ctx);
      if (manager && scopeId && scopeId !== nextScope) {
        const closing = manager;
        manager = undefined;
        void closing.dispose();
      }
      scopeId = nextScope;
      ui = ctx.hasUI ? ctx.ui : undefined;
      manager ??= createManager(scopeId);
      widget.attach(ui);
    });

    // Dialogs and occasional TUI rebuilds can drop widget components. Reassert
    // the keyed widget at stable agent boundaries even when the count is unchanged.
    pi.on('agent_start', () => widget.reassert());
    pi.on('agent_settled', () => widget.reassert());

    pi.on('session_shutdown', async (_event, ctx) => {
      const closingScope = getSessionScopeId(ctx);
      if (scopeId !== closingScope) return;
      const closing = manager;
      const closingServices = scopedServices;
      manager = undefined;
      scopeId = undefined;
      scopedServices = undefined;
      widget.detach();
      ui = undefined;
      await closing?.dispose();
      if (closingScope) releaseScopedServices(closingScope, closingServices);
    });

    registerBackgroundTool(pi, getManager);
    registerBackgroundMessageRenderer(pi);
    registerBackgroundCommands(pi, getManager, () => widget.reassert());
  },
);
