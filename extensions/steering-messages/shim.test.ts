import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import {
  installSteeringMessageShim,
  STEERING_LABEL,
  type SteeringShimHost,
} from './shim';

class FakeContainer implements Component {
  children: Component[] = [];
  addChild(child: Component): void {
    this.children.push(child);
  }
  invalidate(): void {}
  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }
}

class FakeUser extends FakeContainer {
  constructor(public text: string) {
    super();
  }
  override render(): string[] {
    return [`user:${this.text}`];
  }
}

function host(marked: ReadonlySet<number>): SteeringShimHost {
  return {
    userComponent: FakeUser as unknown as SteeringShimHost['userComponent'],
    container: FakeContainer as unknown as SteeringShimHost['container'],
    isSteering: (_text, occurrence) => marked.has(occurrence),
  };
}

describe('steering message TUI shim', () => {
  it('labels only marked user occurrences and leaves ordinary rows untouched', () => {
    const chat = new FakeContainer();
    chat.addChild(new FakeUser('same'));
    chat.addChild(new FakeUser('same'));
    chat.addChild(new FakeUser('other'));
    const stop = installSteeringMessageShim(host(new Set([1])));
    expect(stop).toBeDefined();
    expect(chat.render(80)).toEqual([
      'user:same',
      `user:same ${STEERING_LABEL}`,
      'user:other',
    ]);
    stop?.();
    expect(chat.render(80)).toEqual(['user:same', 'user:same', 'user:other']);
  });

  it('marks components already present when the shim is installed for history', () => {
    const chat = new FakeContainer();
    chat.addChild(new FakeUser('history'));
    const stop = installSteeringMessageShim({
      ...host(new Set([0])),
    });
    expect(chat.render(80)).toEqual([`user:history ${STEERING_LABEL}`]);
    stop?.();
  });
});
