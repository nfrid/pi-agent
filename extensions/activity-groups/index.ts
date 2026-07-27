/**
 * Collapse each model turn's thinking and tool calls into one labelled
 * activity group, the way Claude Code / Codex / cursor-agent present agent work.
 *
 * Rendering lives in `renderer.ts` and speaks only the tool-sequence contract in
 * `types.ts`, which is the API proposed upstream. When the host provides
 * `registerToolSequenceRenderer` natively we register and we are done; until
 * then `shim.ts` synthesises the same contract by patching interactive-mode
 * component prototypes.
 */

import {
  AssistantMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
  ToolExecutionComponent,
} from '@earendil-works/pi-coding-agent';
import type { Container } from '@earendil-works/pi-tui';
import { defineExtension } from '../shared/runtime/extension';
import { createActivityGroupRenderer } from './renderer';
import { installToolSequenceShim, type ShimHost } from './shim';
import type { SequenceRenderer } from './types';

const DEBUG = Boolean(process.env.PI_ACTIVITY_GROUPS_DEBUG);

type HostWithSequenceRenderer = ExtensionAPI & {
  registerToolSequenceRenderer(renderer: SequenceRenderer): void;
};

function hasNativeHook(pi: ExtensionAPI): pi is HostWithSequenceRenderer {
  return (
    'registerToolSequenceRenderer' in pi &&
    typeof (pi as HostWithSequenceRenderer).registerToolSequenceRenderer ===
      'function'
  );
}

/**
 * Pi's own `Container`, taken from the class chain rather than imported.
 *
 * Importing `@earendil-works/pi-tui` could resolve to a second copy of the
 * package, and patching that copy's prototype would do nothing to the instances
 * Pi actually renders. The base class of the components is the only definition
 * guaranteed to be the right one.
 */
function containerClassOf(
  component: typeof AssistantMessageComponent,
): typeof Container | undefined {
  const base = Object.getPrototypeOf(component.prototype) as object | null;
  return (base?.constructor ?? undefined) as typeof Container | undefined;
}

/**
 * Verify the host still looks the way the shim expects before patching it.
 * A renamed method or a bundled build means we leave rendering alone.
 */
function shimIsSupported(container: typeof Container | undefined): boolean {
  if (!container) return false;
  // Both components must sit on the container we are about to patch.
  if (
    !(AssistantMessageComponent.prototype instanceof container) ||
    !(ToolExecutionComponent.prototype instanceof container)
  )
    return false;
  const [assistant, tool, base] = [
    AssistantMessageComponent.prototype,
    ToolExecutionComponent.prototype,
    container.prototype,
  ].map((prototype) => prototype as unknown as Record<string, unknown>);
  return [
    assistant?.render,
    assistant?.updateContent,
    tool?.render,
    tool?.updateResult,
    tool?.markExecutionStarted,
    base?.render,
    base?.addChild,
    base?.removeChild,
    base?.clear,
  ].every((member) => typeof member === 'function');
}

export default defineExtension('activity-groups', (pi) => {
  const renderer = createActivityGroupRenderer();

  if (hasNativeHook(pi)) {
    pi.registerToolSequenceRenderer(renderer);
    return;
  }

  let context: ExtensionContext | undefined;
  let uninstall: (() => void) | undefined;

  const warn = (message: string) => {
    if (DEBUG) context?.ui.notify(`activity-groups: ${message}`, 'warning');
  };

  const install = () => {
    if (uninstall || !context) return;
    const container = containerClassOf(AssistantMessageComponent);
    if (!shimIsSupported(container)) {
      warn('unsupported Pi build, grouping stays off');
      return;
    }
    uninstall = installToolSequenceShim(renderer, {
      assistantComponent:
        AssistantMessageComponent as unknown as ShimHost['assistantComponent'],
      toolComponent:
        ToolExecutionComponent as unknown as ShimHost['toolComponent'],
      container: container as unknown as ShimHost['container'],
      getTheme: () => {
        if (!context) throw new Error('no extension context');
        return context.ui.theme;
      },
      // Idle means the agent is not streaming, so nothing can still be running.
      isBusy: () => context?.isIdle() === false,
      isExpanded: () => context?.ui.getToolsExpanded() ?? false,
      onError: (error) => {
        uninstall = undefined;
        warn(
          `grouping disabled (${error instanceof Error ? error.message : String(error)})`,
        );
      },
      onWarn: (error) => {
        warn(
          `one group fell back to plain rendering (${error instanceof Error ? error.message : String(error)})`,
        );
      },
    });
  };

  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    // Only the interactive TUI renders these components at all.
    if (ctx.mode === 'tui') install();
  });

  pi.registerCommand('activity-groups', {
    description: 'Toggle collapsing tool calls into activity groups',
    handler: async (_args, ctx) => {
      context = ctx;
      if (uninstall) {
        uninstall();
        uninstall = undefined;
        ctx.ui.notify('Activity groups off', 'info');
        return;
      }
      install();
      ctx.ui.notify(
        uninstall ? 'Activity groups on' : 'Activity groups unavailable',
        uninstall ? 'info' : 'warning',
      );
    },
  });
});
