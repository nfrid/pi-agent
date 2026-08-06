import { type Component, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import {
  installSteeringMessageShim,
  type SteeringShimHost,
  USER_MESSAGE_BORDER,
} from './shim';

class FakeUser implements Component {
  constructor(public text: string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [` user:${this.text}`.slice(0, width).padEnd(width)];
  }
}

const STEERING_BORDER = `\x1b[43m\x1b[33m${USER_MESSAGE_BORDER}\x1b[39m\x1b[49m`;
const ORDINARY_BORDER = `\x1b[43m\x1b[35m${USER_MESSAGE_BORDER}\x1b[39m\x1b[49m`;

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
    renderBorderCell: (text, steering) =>
      `\x1b[43m\x1b[${steering ? '33' : '35'}m${text}\x1b[39m\x1b[49m`,
  };
}

describe('steering message TUI shim', () => {
  it('renders ordinary and steering rails without changing width or padding', () => {
    const ordinary = new FakeUser('same');
    const steering = new FakeUser('same');
    const stop = installSteeringMessageShim(host(new Set([1])));
    expect(stop).toBeDefined();
    const ordinaryLine = ordinary.render(12)[0] ?? '';
    expect(ordinaryLine.startsWith(ORDINARY_BORDER)).toBe(true);
    expect(ordinaryLine).toContain('user:same');
    const steeringLine = steering.render(12)[0] ?? '';
    expect(steeringLine.startsWith(STEERING_BORDER)).toBe(true);
    expect(steeringLine).toContain('user:same');
    expect(visibleWidth(ordinaryLine)).toBe(12);
    expect(visibleWidth(steeringLine)).toBe(12);
    expect(visibleWidth(steering.render(3)[0] ?? '')).toBe(3);
    stop?.();
    expect(steering.render(12)[0]?.trim()).toBe('user:same');
  });

  it('keeps duplicate occurrence counts across microtasks and rerenders', async () => {
    const resolutions: Array<[string, number]> = [];
    const resolve = vi.fn((text: string, occurrence: number) => {
      resolutions.push([text, occurrence]);
    });
    const stop = installSteeringMessageShim(host(new Set([1]), resolve));
    const first = new FakeUser('same');
    expect(first.render(80)[0]).toContain(ORDINARY_BORDER);
    await new Promise<void>((done) => queueMicrotask(done));
    const second = new FakeUser('same');
    expect(second.render(80)[0]).toContain(STEERING_BORDER);
    expect(first.render(80)[0]).toContain(ORDINARY_BORDER);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(resolutions).toEqual([
      ['same', 0],
      ['same', 1],
      ['same', 0],
    ]);
    stop?.();
  });

  it('updates an ordinary live rail after its steering marker arrives', () => {
    const marked = new Set<number>();
    const stop = installSteeringMessageShim(host(marked));
    const message = new FakeUser('live');
    expect(message.render(20)[0]).toContain(ORDINARY_BORDER);
    marked.add(0);
    expect(message.render(20)[0]).toContain(STEERING_BORDER);
    stop?.();
  });

  it('returns undefined without patching an unsupported public component', () => {
    class Unsupported {}
    expect(
      installSteeringMessageShim({
        userComponent:
          Unsupported as unknown as SteeringShimHost['userComponent'],
        isSteering: () => true,
        renderBorderCell: (text) => text,
      }),
    ).toBeUndefined();
  });
});
