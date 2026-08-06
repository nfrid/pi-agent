import { type Component, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import {
  installSteeringMessageShim,
  STEERING_BORDER,
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
    renderBorder: (text) => `\x1b[33m${text}\x1b[39m`,
  };
}

describe('steering message TUI shim', () => {
  it('renders a width-safe colored right border and leaves ordinary output untouched', () => {
    const ordinary = new FakeUser('same');
    const steering = new FakeUser('same');
    const stop = installSteeringMessageShim(host(new Set([1])));
    expect(stop).toBeDefined();
    expect(ordinary.render(80)).toEqual(['user:same']);
    const lines = steering.render(12);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(`^\\x1b\\[33m${STEERING_BORDER}\\x1b\\[39m `),
    );
    expect(visibleWidth(lines[0] ?? '')).toBe(12);
    expect(visibleWidth(steering.render(3)[0] ?? '')).toBe(3);
    stop?.();
    expect(steering.render(3)).toEqual(['user:same']);
  });

  it('keeps duplicate occurrence counts across microtasks and rerenders', async () => {
    const resolutions: Array<[string, number]> = [];
    const resolve = vi.fn((text: string, occurrence: number) => {
      resolutions.push([text, occurrence]);
    });
    const stop = installSteeringMessageShim(host(new Set([1]), resolve));
    const first = new FakeUser('same');
    expect(first.render(80)).toEqual(['user:same']);
    await new Promise<void>((done) => queueMicrotask(done));
    const second = new FakeUser('same');
    expect(second.render(80)[0]).toContain(
      `\x1b[33m${STEERING_BORDER}\x1b[39m`,
    );
    expect(first.render(80)).toEqual(['user:same']);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(resolutions).toEqual([
      ['same', 0],
      ['same', 1],
      ['same', 0],
    ]);
    stop?.();
  });

  it('picks up a live marker recorded after the component first renders', () => {
    const marked = new Set<number>();
    const stop = installSteeringMessageShim(host(marked));
    const message = new FakeUser('live');
    expect(message.render(20)).toEqual(['user:live']);
    marked.add(0);
    expect(message.render(20)[0]).toContain(
      `\x1b[33m${STEERING_BORDER}\x1b[39m`,
    );
    stop?.();
  });

  it('returns undefined without patching an unsupported public component', () => {
    class Unsupported {}
    expect(
      installSteeringMessageShim({
        userComponent:
          Unsupported as unknown as SteeringShimHost['userComponent'],
        isSteering: () => true,
        renderBorder: (text) => text,
      }),
    ).toBeUndefined();
  });
});
