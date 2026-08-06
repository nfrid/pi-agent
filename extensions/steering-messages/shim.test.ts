import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import {
  installSteeringMessageShim,
  STEERING_LABEL,
  type SteeringShimHost,
} from './shim';

class FakeUser implements Component {
  constructor(public text: string) {}
  invalidate(): void {}
  render(_width: number): string[] {
    return [`user:${this.text}`];
  }
}

function host(
  marked: ReadonlySet<number>,
  onResolve?: (text: string, occurrence: number) => void,
): SteeringShimHost {
  return {
    userComponent: FakeUser as unknown as SteeringShimHost['userComponent'],
    isSteering: (text, occurrence) => {
      onResolve?.(text, occurrence);
      return marked.has(occurrence);
    },
  };
}

describe('steering message TUI shim', () => {
  it('renders a width-safe separate label and leaves ordinary output untouched', () => {
    const ordinary = new FakeUser('same');
    const steering = new FakeUser('same');
    const stop = installSteeringMessageShim(host(new Set([1])));
    expect(stop).toBeDefined();
    expect(ordinary.render(80)).toEqual(['user:same']);
    expect(steering.render(3)).toEqual(['ste', 'user:same']);
    expect(steering.render(3)[0]?.length).toBeLessThanOrEqual(3);
    stop?.();
    expect(steering.render(3)).toEqual(['user:same']);
  });

  it('keeps duplicate occurrence counts across microtasks while caching rerenders', async () => {
    const resolutions: Array<[string, number]> = [];
    const resolve = vi.fn((text: string, occurrence: number) => {
      resolutions.push([text, occurrence]);
    });
    const stop = installSteeringMessageShim(host(new Set([1]), resolve));
    const first = new FakeUser('same');
    expect(first.render(80)).toEqual(['user:same']);
    await new Promise<void>((done) => queueMicrotask(done));
    const second = new FakeUser('same');
    expect(second.render(80)).toEqual([STEERING_LABEL, 'user:same']);
    expect(first.render(80)).toEqual(['user:same']);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolutions).toEqual([
      ['same', 0],
      ['same', 1],
    ]);
    stop?.();
  });

  it('returns undefined without patching an unsupported public component', () => {
    class Unsupported {}
    expect(
      installSteeringMessageShim({
        userComponent:
          Unsupported as unknown as SteeringShimHost['userComponent'],
        isSteering: () => true,
      }),
    ).toBeUndefined();
  });
});
