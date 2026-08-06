import type { Component } from '@earendil-works/pi-tui';

export const STEERING_LABEL = 'steer';

type ComponentClass<T> = abstract new (...args: never[]) => T;

interface UserMessageLike extends Component {
  render(width: number): string[];
}

interface ContainerLike extends Component {
  children: Component[];
  render(width: number): string[];
}

export interface SteeringShimHost {
  userComponent: ComponentClass<UserMessageLike>;
  container: ComponentClass<ContainerLike>;
  isSteering(text: string, occurrence: number): boolean;
}

function userText(component: UserMessageLike): string | undefined {
  const value = (component as unknown as { text?: unknown }).text;
  return typeof value === 'string' ? value : undefined;
}

function supported(host: SteeringShimHost): boolean {
  const userPrototype = host.userComponent.prototype as UserMessageLike;
  const containerPrototype = host.container.prototype as ContainerLike;
  return (
    userPrototype instanceof host.container &&
    typeof userPrototype.render === 'function' &&
    typeof containerPrototype.render === 'function'
  );
}

/**
 * Patch the public user component and the Container class Pi actually uses.
 * Marking happens from the containing chat's child order, which makes the
 * timestamp-backed history markers work even though UserMessageComponent's
 * public constructor only receives text.
 */
export function installSteeringMessageShim(
  host: SteeringShimHost,
): (() => void) | undefined {
  if (!supported(host)) return undefined;
  const userPrototype = host.userComponent.prototype as UserMessageLike;
  const containerPrototype = host.container.prototype as ContainerLike;
  const originalUserRender = userPrototype.render;
  const originalContainerRender = containerPrototype.render;
  const marked = new WeakSet<UserMessageLike>();

  userPrototype.render = function render(width: number): string[] {
    const lines = originalUserRender.call(this, width);
    if (!marked.has(this) || lines.length === 0) return lines;
    return lines.map((line, index) =>
      index === 0 ? `${line} ${STEERING_LABEL}` : line,
    );
  };

  containerPrototype.render = function render(width: number): string[] {
    const occurrences = new Map<string, number>();
    for (const child of this.children) {
      if (!(child instanceof host.userComponent)) continue;
      const text = userText(child);
      if (text === undefined) continue;
      const occurrence = occurrences.get(text) ?? 0;
      occurrences.set(text, occurrence + 1);
      if (host.isSteering(text, occurrence)) marked.add(child);
    }
    return originalContainerRender.call(this, width);
  };

  return () => {
    userPrototype.render = originalUserRender;
    containerPrototype.render = originalContainerRender;
  };
}

export type { ContainerLike, UserMessageLike };
