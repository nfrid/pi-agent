import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';

export const STEERING_BORDER = '│';

type ComponentClass<T> = abstract new (...args: never[]) => T;

interface UserMessageLike extends Component {
  render(width: number): string[];
}

export interface SteeringShimHost {
  userComponent: ComponentClass<UserMessageLike>;
  isSteering(text: string, occurrence: number): boolean;
  renderBorder(text: string): string;
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
 * mistaken for the first historical occurrence; the WeakMap keeps rerenders
 * from incrementing them.
 */
export function installSteeringMessageShim(
  host: SteeringShimHost,
): (() => void) | undefined {
  if (!supported(host)) return undefined;
  const userPrototype = host.userComponent.prototype as UserMessageLike;
  const originalUserRender = userPrototype.render;
  const steeringByComponent = new WeakMap<UserMessageLike, boolean>();
  const occurrences = new Map<string, number>();

  userPrototype.render = function render(width: number): string[] {
    let steering = steeringByComponent.get(this);
    if (steering === undefined) {
      const text = userText(this);
      if (text === undefined) steering = false;
      else {
        const occurrence = occurrences.get(text) ?? 0;
        occurrences.set(text, occurrence + 1);
        steering = host.isSteering(text, occurrence);
      }
      steeringByComponent.set(this, steering);
    }

    const lines = originalUserRender.call(this, width);
    if (!steering || width < 1) return lines;
    const contentWidth = width - 1;
    return lines.map((line) => {
      const content = truncateToWidth(line, contentWidth, '');
      const padding = ' '.repeat(
        Math.max(0, contentWidth - visibleWidth(content)),
      );
      return `${content}${padding}${host.renderBorder(STEERING_BORDER)}`;
    });
  };

  return () => {
    userPrototype.render = originalUserRender;
    occurrences.clear();
  };
}

export type { UserMessageLike };
