import type { Component } from '@earendil-works/pi-tui';

export const STEERING_LABEL = 'steer';

type ComponentClass<T> = abstract new (...args: never[]) => T;

interface UserMessageLike extends Component {
  render(width: number): string[];
}

export interface SteeringShimHost {
  userComponent: ComponentClass<UserMessageLike>;
  isSteering(text: string, occurrence: number): boolean;
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
 * Patch only the public user component. Pi renders the chat synchronously, so
 * the first render of each component resolves its text occurrence against the
 * marker index. Counters reset after that render batch; the WeakMap keeps a
 * component's answer stable when it is measured or redrawn again.
 */
export function installSteeringMessageShim(
  host: SteeringShimHost,
): (() => void) | undefined {
  if (!supported(host)) return undefined;
  const userPrototype = host.userComponent.prototype as UserMessageLike;
  const originalUserRender = userPrototype.render;
  const steeringByComponent = new WeakMap<UserMessageLike, boolean>();
  const occurrences = new Map<string, number>();
  let resetQueued = false;

  const queueOccurrenceReset = () => {
    if (resetQueued) return;
    resetQueued = true;
    queueMicrotask(() => {
      occurrences.clear();
      resetQueued = false;
    });
  };

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
    queueOccurrenceReset();

    const lines = originalUserRender.call(this, width);
    if (!steering) return lines;
    const label = STEERING_LABEL.slice(0, Math.max(0, width));
    return [label, ...lines];
  };

  return () => {
    userPrototype.render = originalUserRender;
  };
}

export type { UserMessageLike };
