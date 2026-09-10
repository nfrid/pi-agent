import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionScrollController } from './scroll-controller';
import type { SessionScrollMemory } from './scroll-memory';

const manual: SessionScrollMemory = {
  version: 1,
  mode: 'manual',
  scrollTop: 420,
  oldestOrdinal: 0,
};
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function element() {
  return {
    scrollTop: 420,
    scrollHeight: 1000,
    clientHeight: 100,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0 }),
  } as unknown as HTMLDivElement;
}
function flush() {
  for (const [id, callback] of [...frames]) {
    frames.delete(id);
    callback(0);
  }
}
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout,
    clearTimeout,
    sessionStorage: { setItem: vi.fn() },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('per-visit scroll controller', () => {
  it('keeps manual reading on programmatic bottom scrolls, rearms only on user return', () => {
    const controller = new SessionScrollController(manual);
    const port = element();
    controller.connect(port);
    controller.updateHistory(undefined, false);
    controller.snapshot().command?.complete();
    port.scrollTop = 900;
    controller.onScroll();
    controller.contentChanged();
    flush();
    expect(controller.snapshot().phase).toBe('reading');
    port.scrollTop = 700;
    controller.onScroll();
    controller.userIntent(1);
    port.scrollTop = 850;
    controller.onScroll();
    expect(controller.snapshot().phase).toBe('reading');
    port.scrollTop = 861;
    controller.onScroll();
    expect(controller.snapshot().phase).toBe('following');
    controller.disconnect();
  });

  it('cancels tail writes, commands and settlement on upward input', () => {
    const controller = new SessionScrollController();
    const port = element();
    controller.connect(port);
    const command = controller.snapshot().command;
    const staleFrame = [...frames.values()][0];
    controller.userIntent(-1);
    staleFrame(0);
    command?.complete();
    flush();
    vi.runAllTimers();
    expect(port.scrollTop).toBe(420);
    expect(command?.signal.aborted).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      phase: 'reading',
      ready: true,
    });
    controller.disconnect();
  });

  it('invalidates old work across A-B-A and reconnect, even if a cancelled callback runs', () => {
    const port = element();
    const a = new SessionScrollController();
    a.connect(port);
    const staleFrame = [...frames.values()][0];
    a.disconnect();
    const b = new SessionScrollController(manual);
    b.connect(port);
    b.updateHistory(undefined, false);
    const oldRestore = b.snapshot().command;
    b.disconnect();
    const again = new SessionScrollController(manual);
    again.connect(port);
    again.updateHistory(undefined, false);
    staleFrame(0);
    oldRestore?.complete();
    expect(port.scrollTop).toBe(420);
    expect(again.snapshot().phase).toBe('restoring');
    again.snapshot().command?.complete();
    again.disconnect();
    // React StrictMode reconnects the same instance, too.
    a.connect(port);
    a.userIntent(-1);
    staleFrame(0);
    expect(port.scrollTop).toBe(420);
    a.disconnect();
  });

  it('waits for coverage and retains one load through callback changes and failed multi-page load', async () => {
    const controller = new SessionScrollController(manual);
    controller.connect(element());
    controller.updateHistory(undefined, true);
    expect(controller.snapshot().command).toBeUndefined();
    let reject!: (reason: Error) => void;
    const load = vi.fn(
      () =>
        new Promise<boolean>((_, fail) => {
          reject = fail;
        }),
    );
    controller.updateHistory({ start: 100, hasOlder: true }, true, load);
    const replacement = vi.fn();
    controller.updateHistory({ start: 50, hasOlder: true }, true, replacement);
    expect(load).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    reject(new Error('page two failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.snapshot().command?.kind).toBe('anchor');
    controller.snapshot().command?.complete();
    expect(controller.snapshot()).toMatchObject({
      ready: true,
      phase: 'reading',
    });
    controller.disconnect();
  });

  it('does not fetch old pages for following memory', () => {
    const controller = new SessionScrollController({
      ...manual,
      mode: 'following',
    });
    controller.connect(element());
    const load = vi.fn();
    controller.updateHistory({ start: 100, hasOlder: true }, true, load);
    expect(load).not.toHaveBeenCalled();
    controller.disconnect();
  });

  it('ignores pending history after cancellation or disconnect', async () => {
    for (const disconnect of [false, true]) {
      const controller = new SessionScrollController(manual);
      controller.connect(element());
      let resolve!: (loaded: boolean) => void;
      controller.updateHistory(
        { start: 100, hasOlder: true },
        true,
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      );
      if (disconnect) controller.disconnect();
      else controller.read();
      resolve(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.snapshot().command).toBeUndefined();
      controller.disconnect();
    }
  });

  it('does not lose initial readiness to resize writes and keeps following new output', () => {
    const controller = new SessionScrollController();
    const port = element();
    controller.connect(port);
    controller.contentChanged();
    controller.contentChanged();
    flush();
    expect(port.scrollTop).toBe(1000);
    controller.contentChanged();
    flush();
    vi.advanceTimersByTime(64);
    expect(controller.snapshot().ready).toBe(true);
    Object.defineProperty(port, 'scrollHeight', { value: 1300 });
    controller.contentChanged();
    flush();
    expect(port.scrollTop).toBe(1300);
    controller.disconnect();
  });

  it('settles the persisted anchor after virtual row measurement', () => {
    const key = 'session-memory';
    let rowTop = 12;
    const row = {
      dataset: { transcriptKey: 'message-1' },
      getBoundingClientRect: () => ({ top: rowTop, bottom: rowTop + 20 }),
    } as unknown as HTMLElement;
    const port = element();
    port.querySelectorAll = (() => [
      row,
    ]) as unknown as typeof port.querySelectorAll;
    const controller = new SessionScrollController(manual, key);
    controller.connect(port);
    controller.updateHistory(undefined, false);
    controller.snapshot().command?.complete();
    controller.onScroll();

    port.scrollTop = 650;
    rowTop = 70;
    flush();
    flush();

    expect(
      JSON.parse(
        vi.mocked(window.sessionStorage.setItem).mock.lastCall?.[1] ?? '{}',
      ),
    ).toMatchObject({ scrollTop: 650, rowKey: 'message-1', rowOffset: 70 });
    controller.disconnect();
  });

  it('reschedules observation after a read cancels pending observation', () => {
    const controller = new SessionScrollController(manual, 'session-memory');
    const port = element();
    controller.connect(port);
    controller.updateHistory(undefined, false);
    controller.snapshot().command?.complete();
    controller.onScroll();
    controller.read();
    controller.onScroll();
    expect(frames.size).toBe(1);
    controller.disconnect();
  });

  it('persists captured old viewport, not changed DOM on disconnect, and never saves transient restoration', () => {
    const key = 'session-memory';
    const controller = new SessionScrollController(manual, key);
    const port = element();
    controller.connect(port);
    controller.onScroll();
    controller.disconnect();
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled();
    controller.connect(port);
    controller.updateHistory(undefined, false);
    controller.snapshot().command?.complete();
    port.scrollTop = 600;
    controller.onScroll();
    port.scrollTop = 0;
    controller.disconnect();
    expect(
      JSON.parse(
        vi.mocked(window.sessionStorage.setItem).mock.lastCall?.[1] ?? '{}',
      ),
    ).toMatchObject({ mode: 'manual', scrollTop: 600 });
  });
});
