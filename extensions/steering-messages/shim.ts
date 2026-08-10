import { type Component, sliceByColumn } from '@earendil-works/pi-tui';

export const USER_MESSAGE_BORDER = '▏';
const ANSI_STYLE_RESET = '\x1b[0m';
// A harmless, deliberately distinctive SGR reset marks lines already rewritten
// by this shim. It survives ANSI-aware slicing without changing visible width.
const RAIL_MARKER = '\x1b[0;0;0m';

type ComponentClass<T> = abstract new (...args: never[]) => T;

interface UserMessageLike extends Component {
  render(width: number): string[];
}

export interface SteeringShimHost {
  userComponent: ComponentClass<UserMessageLike>;
  isSteering(text: string, occurrence: number): boolean;
  renderBorderCell(text: string, steering: boolean): string;
}

function userText(component: UserMessageLike): string | undefined {
  const value = (component as unknown as { text?: unknown }).text;
  return typeof value === 'string' ? value : undefined;
}

function supported(host: SteeringShimHost): boolean {
  const userPrototype = host.userComponent.prototype as UserMessageLike;
  return typeof userPrototype.render === 'function';
}

/**
 * Patch only the public user component. The first render of each component
 * resolves its text occurrence against the current session's marker index.
 * Counts live for this installation so a newly appended duplicate is not
 * mistaken for the first historical occurrence. A negative match is retried
 * because a live component can render just before its marker is persisted.
 */
export function installSteeringMessageShim(
  host: SteeringShimHost,
): (() => void) | undefined {
  if (!supported(host)) return undefined;
  const userPrototype = host.userComponent.prototype as UserMessageLike;
  const originalUserRender = userPrototype.render;
  const stateByComponent = new WeakMap<
    UserMessageLike,
    { text?: string; occurrence?: number; steering: boolean }
  >();
  const occurrences = new Map<string, number>();

  userPrototype.render = function render(width: number): string[] {
    let state = stateByComponent.get(this);
    if (!state) {
      const text = userText(this);
      if (text === undefined) state = { steering: false };
      else {
        const occurrence = occurrences.get(text) ?? 0;
        occurrences.set(text, occurrence + 1);
        state = {
          text,
          occurrence,
          steering: host.isSteering(text, occurrence),
        };
      }
      stateByComponent.set(this, state);
    } else if (
      !state.steering &&
      state.text !== undefined &&
      state.occurrence !== undefined
    ) {
      state.steering = host.isSteering(state.text, state.occurrence);
    }

    const lines = originalUserRender.call(this, width);
    if (width < 1) return lines;
    return lines.map((line) => {
      const marker = line.indexOf(RAIL_MARKER);
      let body: string;
      if (marker >= 0) body = line.slice(marker + RAIL_MARKER.length);
      else {
        // The first reload after upgrading can still call the previous,
        // unmarked wrapper. Strip its known rail instead of slicing it: ANSI
        // slicing would replay that rail's foreground immediately before the
        // message body and color the whole line pink/orange.
        const previousPrefix = [false, true]
          .map(
            (steering) =>
              `${host.renderBorderCell(USER_MESSAGE_BORDER, steering)}${ANSI_STYLE_RESET}`,
          )
          .find((prefix) => line.startsWith(prefix));
        body = previousPrefix
          ? line.slice(previousPrefix.length)
          : sliceByColumn(line, 1, width - 1);
      }
      return `${host.renderBorderCell(USER_MESSAGE_BORDER, state.steering)}${ANSI_STYLE_RESET}${RAIL_MARKER}${body}`;
    });
  };

  return () => {
    userPrototype.render = originalUserRender;
    occurrences.clear();
  };
}

export type { UserMessageLike };
