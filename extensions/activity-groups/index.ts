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
  type Theme,
  ToolExecutionComponent,
} from '@earendil-works/pi-coding-agent';
import type { Container } from '@earendil-works/pi-tui';
import { getPauseCoordinator } from '../pause/state';
import { defineExtension } from '../shared/runtime/extension';
import { getSessionScopeId } from '../shared/runtime/scoped-services';
import { installActivityGroupsActionHandler } from './actions';
import { registerActivityGroupsCapability } from './register-capability';
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
 *
 * Exactly the methods the shim replaces, and nothing else. The instance fields
 * it reads — `lastMessage`, `toolName`, `result` and the rest — are set in
 * constructors and cannot be seen from a prototype; `installed-pi.test.ts`
 * checks those against real instances of the installed build.
 */
function shimIsSupported(container: typeof Container | undefined): boolean {
  if (!container) return false;
  // Both components must sit on the container we are about to patch.
  if (
    !(AssistantMessageComponent.prototype instanceof container) ||
    !(ToolExecutionComponent.prototype instanceof container)
  )
    return false;
  const patched: [object, string[]][] = [
    [AssistantMessageComponent.prototype, ['render', 'updateContent']],
    [ToolExecutionComponent.prototype, ['render']],
    [container.prototype, ['render', 'addChild', 'removeChild', 'clear']],
  ];
  return patched.every(([prototype, methods]) =>
    methods.every(
      (method) =>
        typeof (prototype as Record<string, unknown>)[method] === 'function',
    ),
  );
}

export default defineExtension('activity-groups', (pi) => {
  registerActivityGroupsCapability();
  const activityRenderer = createActivityGroupRenderer();
  let enabled = true;
  let context: ExtensionContext | undefined;
  const paused = () => {
    if (!context) return false;
    try {
      return getPauseCoordinator(getSessionScopeId(context)).isActive();
    } catch {
      return false;
    }
  };
  const renderer: SequenceRenderer = (
    sequence,
    options,
    theme,
    renderContext,
  ) =>
    enabled
      ? activityRenderer(
          sequence,
          { ...options, animated: options.streaming && !paused() },
          theme,
          renderContext,
        )
      : options.defaultView;

  const nativeHook = hasNativeHook(pi);
  if (nativeHook) pi.registerToolSequenceRenderer(renderer);

  let uninstall: (() => void) | undefined;
  let uninstallActionHandler: (() => void) | undefined;
  /**
   * Whether groups show their members, independently of Pi's own tool-output
   * expansion. These are different questions — "what did it do" versus "what
   * did that print" — and answering the first should not bury you in the
   * second. Pi's flag still opens groups, since with grouping on there would
   * otherwise be nothing for it to reveal.
   */
  let opened = false;
  /** The last theme a live context handed us. See `active`. */
  let theme: Theme | undefined;

  /**
   * Read something from the extension context, or nothing if the session it
   * belonged to has been replaced.
   *
   * `/resume`, `/new` and `/fork` retire a context: every accessor on it throws
   * from then until the next `session_start` arrives. The shim reads the
   * context from inside `render`, so an unguarded read takes the TUI down with
   * it — which is exactly what a stale one did. Anything that throws here has
   * already lost its session, so the context is dropped and grouping runs on
   * without it until the new one lands.
   */
  const active = <T>(read: (ctx: ExtensionContext) => T): T | undefined => {
    if (!context) return undefined;
    try {
      return read(context);
    } catch {
      context = undefined;
      return undefined;
    }
  };

  const notify = (message: string) =>
    active((ctx) => ctx.ui.notify(`activity-groups: ${message}`, 'warning'));

  /**
   * A group that fell back on its own is a curiosity; grouping going away for
   * the rest of the session is something the reader is about to notice and has
   * no other way to explain. So the first is behind PI_ACTIVITY_GROUPS_DEBUG
   * and the second is always said out loud.
   */
  const debug = (message: string) => {
    if (DEBUG) notify(message);
  };

  const reason = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  const install = () => {
    if (!enabled || nativeHook || uninstall || !context) return;
    const container = containerClassOf(AssistantMessageComponent);
    if (!shimIsSupported(container)) {
      notify(
        'this Pi build is not one grouping knows how to patch, staying off',
      );
      return;
    }
    uninstall = installToolSequenceShim(renderer, {
      assistantComponent:
        AssistantMessageComponent as unknown as ShimHost['assistantComponent'],
      toolComponent:
        ToolExecutionComponent as unknown as ShimHost['toolComponent'],
      container: container as unknown as ShimHost['container'],
      // A replaced session still has its transcript on screen and still has to
      // render, so the theme it was last drawn in outlives its context.
      getTheme: () => {
        theme = active((ctx) => ctx.ui.theme) ?? theme;
        if (!theme) throw new Error('no extension context');
        return theme;
      },
      // Staying installed while disabled lets the shim observe transcript
      // changes and rebuild every group when it is enabled again. Its disabled
      // render path is still Pi's exact assistant/tool rendering.
      isEnabled: () => enabled,
      // Idle means the agent is not streaming, so nothing can still be running.
      isBusy: () => active((ctx) => ctx.isIdle()) === false,
      isExpanded: () =>
        opened || (active((ctx) => ctx.ui.getToolsExpanded()) ?? false),
      /**
       * A live group already spins and names what it is doing, so Pi's working
       * line under it is the same sentence twice — and the two spinners beat
       * out of step. It comes straight back the moment no group is live: while
       * the model is only thinking or writing an answer, that line is the only
       * sign anything is happening.
       */
      onLiveChange: (live) => {
        active((ctx) => ctx.ui.setWorkingVisible?.(!live));
      },
      onError: (error) => {
        uninstall = undefined;
        notify(`grouping is off for this session (${reason(error)})`);
      },
      onWarn: (error) => {
        debug(`one group fell back to plain rendering (${reason(error)})`);
      },
    });
  };

  const setEnabled = (next: boolean) => {
    enabled = next;
    if (enabled) install();
  };

  pi.on('session_start', (_event, ctx) => {
    uninstallActionHandler?.();
    context = ctx;
    // The semantic action is available to the bridge even when the installed
    // Pi build has no native renderer hook. Rendering itself remains bounded
    // by the verified shim below.
    uninstallActionHandler = installActivityGroupsActionHandler((input) => {
      if (input.enabled !== undefined) setEnabled(input.enabled);
      if (input.expanded !== undefined) {
        opened = input.expanded;
        if (nativeHook) ctx.ui.setToolsExpanded(opened);
      }
      return {
        enabled: enabled && (nativeHook || Boolean(uninstall)),
        expanded: opened,
      };
    });
    // Only the interactive TUI renders these components at all.
    if (!nativeHook && ctx.mode === 'tui') install();
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (context !== ctx) return;
    uninstallActionHandler?.();
    uninstallActionHandler = undefined;
    uninstall?.();
    uninstall = undefined;
    context = undefined;
  });

  /**
   * Notifying also redraws the transcript, so disabling the renderer restores
   * Pi's stock assistant and tool rows immediately.
   */
  pi.registerCommand('activity-groups', {
    description:
      "Toggle activity groups on or off, restoring Pi's default transcript when off",
    handler: async (args, ctx) => {
      // A command can run before any session_start this extension saw.
      context = ctx;
      const action = args.trim().toLowerCase();
      if (action && action !== 'on' && action !== 'off') {
        ctx.ui.notify(`Usage: /activity-groups [on|off]`, 'warning');
        return;
      }

      setEnabled(action ? action === 'on' : !enabled);
      const available = nativeHook || Boolean(uninstall);
      ctx.ui.notify(
        enabled && !available
          ? 'Activity groups unavailable'
          : `Activity groups ${enabled ? 'on' : 'off'}`,
        enabled && !available ? 'warning' : 'info',
      );
    },
  });
});
