/**
 * A single row of widgets shared by every extension that wants one.
 *
 * The host stacks each keyed widget on its own band above the editor, so two
 * extensions that both want a corner of the screen end up shoving each other
 * up and down the terminal. The rail is one host widget that several panels
 * render into side by side: left-hand panels keep the left edge, right-hand
 * panels keep the right edge, and they only fall back to stacking when the
 * terminal is genuinely too narrow to hold both.
 *
 * The rail has to be a process-wide singleton because extensions are loaded
 * with module caching disabled — each extension gets its own copy of this
 * module — so the shared state lives on a well-known global symbol rather than
 * in a module-level variable.
 */

import type {
  ExtensionUIContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { createManagedWidget, type ManagedWidget } from './widget';

/** Host widget key. One rail, one band. */
const RAIL_WIDGET_KEY = 'shared-ui-rail';
/** Blank columns between the two sides. */
const RAIL_GUTTER = 2;
const RAIL_SINGLETON = Symbol.for('pi.shared.ui.rail');

export type RailSide = 'left' | 'right';

export interface RailPanelOptions {
  /** Stable panel key. Registering the same key again replaces the panel. */
  key: string;
  /** Which edge the panel holds. */
  side: RailSide;
  /** Lower sorts first when a side holds more than one panel. */
  order?: number;
  /** Widest the panel wants to be. It is never given more than this. */
  maxWidth?: number;
  /** Narrowest the panel stays useful at; below this the rail stacks instead. */
  minWidth?: number;
  /** Whether the panel currently has anything to show. */
  isActive: () => boolean;
  /** Render the panel body at the column width the rail granted. */
  render: (width: number, theme: Theme) => string[];
  /** Re-render cadence the rail should drive while this panel is active. */
  refreshMs?: number;
  /** Called when the host rejects a widget update. */
  onError?: (error: unknown) => void;
}

export interface RailPanel {
  /** Bind to a session's UI. Safe to call with `undefined` for headless runs. */
  attach: (ui: ExtensionUIContext | undefined) => void;
  /** Reconcile the rail against panel state, then request a render. */
  sync: () => void;
  /** Re-assert the rail even when nothing changed. */
  reassert: () => void;
  /** Remove the panel and release its UI reference. */
  detach: () => void;
}

interface RailState {
  panels: Map<string, RailPanelOptions>;
  attached: Set<string>;
  widget: ManagedWidget;
  timer?: NodeJS.Timeout;
  timerMs?: number;
}

function padTo(line: string, width: number): string {
  const bounded = truncateToWidth(line, width, '…');
  return `${bounded}${' '.repeat(Math.max(0, width - visibleWidth(bounded)))}`;
}

function panelWidth(panel: RailPanelOptions, available: number): number {
  return Math.max(1, Math.min(available, panel.maxWidth ?? available));
}

/**
 * Join two rendered columns into rows, with the right column held against the
 * right edge. Rows past the end of a column are blank on that side, and a row
 * with nothing on the right keeps no trailing padding.
 */
export function joinRailColumns(
  left: string[],
  right: string[],
  layout: { leftWidth: number; rightWidth: number; width: number },
): string[] {
  const rows = Math.max(left.length, right.length);
  const offset = Math.max(0, layout.width - layout.rightWidth);
  return Array.from({ length: rows }, (_, index) => {
    const leftLine = truncateToWidth(left[index] ?? '', layout.leftWidth, '…');
    const rightLine = right[index] ?? '';
    if (!rightLine) return leftLine;
    return `${padTo(leftLine, offset)}${rightLine}`;
  });
}

/**
 * Lay the active panels out for one width. Exported for tests; the rail widget
 * is the only production caller.
 */
export function renderRail(
  panels: readonly RailPanelOptions[],
  width: number,
  theme: Theme,
): string[] {
  const active = panels
    .filter((panel) => panel.isActive())
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (active.length === 0 || width <= 0) return [];

  const render = (side: RailSide, columnWidth: number) =>
    active
      .filter((panel) => panel.side === side)
      .flatMap((panel) => panel.render(columnWidth, theme));

  const left = active.filter((panel) => panel.side === 'left');
  const right = active.filter((panel) => panel.side === 'right');
  const columnWidth = (panels: RailPanelOptions[], available: number) =>
    Math.max(...panels.map((panel) => panelWidth(panel, available)));
  const alone = (side: RailSide, panels: RailPanelOptions[]) => {
    const own = columnWidth(panels, width);
    return joinRailColumns(
      side === 'left' ? render('left', own) : [],
      side === 'right' ? render('right', own) : [],
      { leftWidth: own, rightWidth: own, width },
    );
  };
  if (left.length === 0) return alone('right', right);
  if (right.length === 0) return alone('left', left);

  const wanted = columnWidth(right, width);
  const leftMin = Math.max(...left.map((panel) => panel.minWidth ?? 1));
  const rightMin = Math.max(...right.map((panel) => panel.minWidth ?? 1));
  // The right side keeps the width it asked for while the left still has room,
  // then gives ground, and only stacks once neither side can be served.
  const rightWidth = Math.min(wanted, width - leftMin - RAIL_GUTTER);
  if (rightWidth >= rightMin) {
    const leftWidth = width - rightWidth - RAIL_GUTTER;
    return joinRailColumns(
      render('left', leftWidth),
      render('right', rightWidth),
      { leftWidth, rightWidth, width },
    );
  }
  return [...alone('left', left), ...alone('right', right)];
}

function railState(): RailState {
  const host = globalThis as typeof globalThis & {
    [RAIL_SINGLETON]?: RailState;
  };
  const existing = host[RAIL_SINGLETON];
  if (existing) return existing;
  const panels = new Map<string, RailPanelOptions>();
  const state: RailState = {
    panels,
    attached: new Set<string>(),
    widget: createManagedWidget({
      key: RAIL_WIDGET_KEY,
      isActive: () => [...panels.values()].some((panel) => panel.isActive()),
      render: (width, theme) => renderRail([...panels.values()], width, theme),
      onError: (error) => {
        for (const panel of panels.values()) panel.onError?.(error);
      },
    }),
  };
  host[RAIL_SINGLETON] = state;
  return state;
}

/**
 * The rail drives one timer for every panel that asked for a cadence, at the
 * shortest cadence any active panel wants, and none at all when no active
 * panel wants one.
 */
function reconcileTimer(state: RailState): void {
  const cadences = [...state.panels.values()]
    .filter((panel) => panel.refreshMs !== undefined && panel.isActive())
    .map((panel) => panel.refreshMs as number);
  const wanted = cadences.length > 0 ? Math.min(...cadences) : undefined;
  if (wanted === state.timerMs) return;
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  state.timerMs = wanted;
  if (wanted === undefined) return;
  state.timer = setInterval(() => state.widget.sync(), wanted);
  state.timer.unref();
}

/** Register a panel on the shared rail. Mirrors the managed-widget lifecycle. */
export function createRailPanel(options: RailPanelOptions): RailPanel {
  const state = railState();
  state.panels.set(options.key, options);

  const sync = () => {
    reconcileTimer(state);
    state.widget.sync();
  };

  return {
    attach(ui) {
      state.panels.set(options.key, options);
      if (ui) {
        state.attached.add(options.key);
        state.widget.attach(ui);
      } else {
        // A headless panel must not pull the rail out from under a panel that
        // does have a UI.
        state.attached.delete(options.key);
        if (state.attached.size === 0) state.widget.attach(undefined);
      }
      reconcileTimer(state);
    },
    sync,
    reassert() {
      reconcileTimer(state);
      state.widget.reassert();
    },
    detach() {
      state.panels.delete(options.key);
      state.attached.delete(options.key);
      reconcileTimer(state);
      // Other extensions may still own panels on the rail, so only the last
      // one out tears the host widget down.
      if (state.attached.size === 0) state.widget.detach();
      else state.widget.sync();
    },
  };
}
