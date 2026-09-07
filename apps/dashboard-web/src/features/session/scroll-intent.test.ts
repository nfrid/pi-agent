import type { TranscriptProjection } from '@pi-dashboard/domain';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useSessionScroll } from './scroll';

// Known baseline defect: remove `.fails` when the visit controller is fixed.
// Run without `.fails` to observe scrollTop 1300 instead of the expected 900.
it.fails('does not resume following after a programmatic bottom scroll', async () => {
  const listeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const element = {
    scrollTop: 0,
    scrollHeight: 1_000,
    clientHeight: 100,
    addEventListener: (type: string, listener: EventListener) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as HTMLDivElement;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout,
    clearTimeout,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const scrollElementRef = { current: element };
  function Probe({ revision }: { revision: number }) {
    useSessionScroll({
      id: 'thread-a',
      data: { entries: [revision] },
      projection: {} as TranscriptProjection,
      sessionMounted: true,
      enabled: true,
      scrollElementRef,
    });
    return null;
  }
  const flushFrames = () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  };
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      tree = create(createElement(Probe, { revision: 0 }));
    });
    await act(async () => flushFrames());
    await act(async () => {
      listeners.get('wheel')?.({ deltaY: -100 } as WheelEvent);
      element.scrollTop = 400;
      listeners.get('scroll')?.(new Event('scroll'));
    });
    // Simulate measurement/restoration reaching the end without user input.
    await act(async () => {
      element.scrollTop = 900;
      listeners.get('scroll')?.(new Event('scroll'));
    });
    await act(async () => {
      Object.defineProperty(element, 'scrollHeight', { value: 1_300 });
      tree?.update(createElement(Probe, { revision: 1 }));
    });
    await act(async () => flushFrames());
    expect(element.scrollTop).toBe(900);
  } finally {
    await act(async () => tree?.unmount());
    vi.unstubAllGlobals();
  }
});
