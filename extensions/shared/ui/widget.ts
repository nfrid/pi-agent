/**
 * One implementation of the keyed-widget lifecycle.
 *
 * Three extensions independently discovered the same set of hazards and solved
 * them three different ways. The behaviour consolidated here is the union of
 * what each of them had learned:
 *
 *   - The TUI can silently drop a keyed widget when a dialog opens or the
 *     component tree is rebuilt, so the widget must be re-asserted at stable
 *     agent boundaries rather than only when its content changes.
 *   - A widget showing elapsed time needs a periodic re-render that must not
 *     outlive the widget, or a disposed session keeps a timer alive.
 *   - Render requests arrive in bursts, so they are coalesced onto one frame.
 *   - `setWidget` can throw while the UI is being torn down. That is expected
 *     transiently and must not crash teardown, but a *persistent* failure
 *     should not be swallowed forever (see `onError`).
 */

import type {
  ExtensionUIContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

/** Coalescing window for burst render requests; roughly one frame. */
const RENDER_COALESCE_MS = 16;

export interface ManagedWidgetOptions {
  /** Stable widget key. Reused for mount, re-assert, and teardown. */
  key: string;
  /**
   * Render the widget body. Returning an empty array unmounts the widget, so
   * emptiness is expressed in one place rather than by the caller pre-checking.
   */
  render: (width: number, theme: Theme) => string[];
  /** Whether the widget should currently be mounted at all. */
  isActive: () => boolean;
  /** Re-render cadence while active. Omit for content-driven updates only. */
  refreshMs?: number;
  /**
   * Called when `setWidget` throws. Invoked at most once per attached UI, so a
   * persistent failure is reported without flooding a teardown path.
   */
  onError?: (error: unknown) => void;
}

export interface ManagedWidget {
  /** Bind to a session's UI. Safe to call with `undefined` for headless runs. */
  attach: (ui: ExtensionUIContext | undefined) => void;
  /** Reconcile mounted state against `isActive()`, then request a render. */
  sync: () => void;
  /**
   * Re-assert the widget even when nothing changed, for use at agent
   * boundaries where the TUI may have dropped it.
   */
  reassert: () => void;
  /** Unmount, clear timers, and release the UI reference. */
  detach: () => void;
}

export function createManagedWidget(
  options: ManagedWidgetOptions,
): ManagedWidget {
  const { key, render, isActive, refreshMs, onError } = options;

  let ui: ExtensionUIContext | undefined;
  let mounted = false;
  let refreshTimer: NodeJS.Timeout | undefined;
  let coalesceTimer: NodeJS.Timeout | undefined;
  let reportedError = false;
  let requestRender = () => {};

  const stopRefreshTimer = () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  };

  const cancelCoalesced = () => {
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
  };

  const requestCoalescedRender = () => {
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      requestRender();
    }, RENDER_COALESCE_MS);
    coalesceTimer.unref();
  };

  /**
   * `setWidget` throwing is expected while the UI tears down, so it never
   * propagates. It is reported once per attached UI so a persistent failure is
   * still visible rather than silently discarded.
   */
  const withUI = (work: (context: ExtensionUIContext) => void): boolean => {
    if (!ui) return false;
    try {
      work(ui);
      return true;
    } catch (error) {
      if (!reportedError) {
        reportedError = true;
        onError?.(error);
      }
      return false;
    }
  };

  const unmount = () => {
    stopRefreshTimer();
    cancelCoalesced();
    requestRender = () => {};
    if (!mounted) return;
    if (withUI((context) => context.setWidget(key, undefined))) mounted = false;
  };

  const mount = () => {
    const succeeded = withUI((context) => {
      context.setWidget(key, (tui: TUI, theme: Theme) => {
        const boundRequestRender = () => tui.requestRender();
        requestRender = boundRequestRender;
        return {
          dispose() {
            // Only clear shared state if this component still owns it; a
            // remount may already have installed a newer one.
            if (requestRender === boundRequestRender) {
              requestRender = () => {};
              mounted = false;
            }
          },
          invalidate() {},
          render: (width: number) => render(width, theme),
        };
      });
    });
    if (!succeeded) return;
    mounted = true;
    if (refreshMs !== undefined && !refreshTimer) {
      refreshTimer = setInterval(requestCoalescedRender, refreshMs);
      refreshTimer.unref();
    }
  };

  const reconcile = (force: boolean) => {
    if (!ui) return;
    if (!isActive()) {
      unmount();
      return;
    }
    if (mounted && !force) {
      requestCoalescedRender();
      return;
    }
    mount();
  };

  return {
    attach(context) {
      ui = context;
      mounted = false;
      reportedError = false;
      requestRender = () => {};
      reconcile(true);
    },
    sync: () => reconcile(false),
    reassert: () => reconcile(true),
    detach() {
      unmount();
      mounted = false;
      ui = undefined;
    },
  };
}
