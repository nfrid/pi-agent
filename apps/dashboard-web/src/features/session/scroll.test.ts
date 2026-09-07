import type { TranscriptProjection } from '@pi-dashboard/domain';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { readSessionScrollMemory, useSessionScroll } from './scroll';

describe('session scroll memory storage', () => {
  it('isolates server sessions and ignores corrupt values', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    try {
      values.set(
        'pi.dashboard.session-scroll.v1:server-a:session-1',
        JSON.stringify({
          version: 1,
          mode: 'manual',
          rowKey: 'message-4',
          rowOffset: 18,
          scrollTop: 420,
          oldestOrdinal: 4,
        }),
      );
      values.set(
        'pi.dashboard.session-scroll.v1:server-b:session-1',
        JSON.stringify({ version: 1, mode: 'following', scrollTop: 0 }),
      );
      expect(readSessionScrollMemory('session-1', 'server-a')?.rowKey).toBe(
        'message-4',
      );
      expect(readSessionScrollMemory('session-1', 'server-b')?.mode).toBe(
        'following',
      );
      values.set('pi.dashboard.session-scroll.v1:server-a:broken', '{bad');
      expect(readSessionScrollMemory('broken', 'server-a')).toBeUndefined();
      values.set(
        'pi.dashboard.session-scroll.v1:server-a:invalid',
        JSON.stringify({ version: 1, mode: 'manual', scrollTop: 'bad' }),
      );
      expect(readSessionScrollMemory('invalid', 'server-a')).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not fail when session storage is unavailable', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
      },
    });
    try {
      expect(readSessionScrollMemory('session-1', 'server-a')).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('session follow lifecycle', () => {
  it('attaches after initial history mounts and preserves manual mode through settlement', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('Element', class {});
    const windowListeners = new Map<string, EventListener>();
    const listeners = new Map<string, Set<EventListener>>();
    let scrollHeight = 1_000;
    const transcript = {
      get scrollHeight() {
        return scrollHeight;
      },
      scrollTop: 0,
      clientHeight: 100,
      addEventListener: (type: string, listener: EventListener) => {
        const typeListeners = listeners.get(type) ?? new Set<EventListener>();
        typeListeners.add(listener);
        listeners.set(type, typeListeners);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      },
    } as unknown as HTMLDivElement;
    const dispatch = (type: string, event: Event = new Event(type)) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const fakeWindow = {
      cancelAnimationFrame: (id: number) => frames.delete(id),
      clearTimeout,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
      },
      setTimeout,
      addEventListener: (type: string, listener: EventListener) =>
        windowListeners.set(type, listener),
      removeEventListener: (type: string) => windowListeners.delete(type),
      innerHeight: 800,
      visualViewport: undefined,
    };
    vi.stubGlobal('window', fakeWindow);
    const runFrames = () => {
      for (const [id, callback] of frames) {
        frames.delete(id);
        callback(0);
      }
    };
    const scrollElementRef = {
      current: null as HTMLDivElement | null,
    };
    let controls!: ReturnType<typeof useSessionScroll>;
    function Probe({
      waiting,
      version,
      id = 'session-1',
    }: {
      waiting: boolean;
      version: number;
      id?: string;
    }) {
      const data = { entries: [`entry-${version}`] };
      const projection = {} as TranscriptProjection;
      controls = useSessionScroll({
        id,
        data,
        projection,
        sessionMounted: Boolean(data && projection && !waiting),
        enabled: true,
        scrollElementRef,
      });
      return null;
    }

    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Probe, { waiting: true, version: 0 }));
      });
      expect(listeners.get('wheel')).toBeUndefined();

      scrollElementRef.current = transcript;
      await act(async () => {
        renderer?.update(createElement(Probe, { waiting: false, version: 1 }));
      });
      await act(async () => runFrames());
      expect(transcript.scrollTop).toBe(1_000);

      scrollHeight = 1_300;
      transcript.scrollTop = 700;
      await act(async () => {
        dispatch('wheel', { deltaY: -100 } as WheelEvent);
        dispatch('scroll');
      });
      expect(controls.awayFromLatest).toBe(true);

      await act(async () => {
        renderer?.update(
          createElement(Probe, {
            waiting: false,
            version: 2,
          }),
        );
      });
      await act(async () => runFrames());
      expect(transcript.scrollTop).toBe(700);
      expect(controls.awayFromLatest).toBe(true);

      await act(async () => controls.jumpToLatest());
      await act(async () => runFrames());
      expect(transcript.scrollTop).toBe(1_300);
      expect(controls.awayFromLatest).toBe(false);
      const oldTailCommand = controls.scrollCommand;
      expect(oldTailCommand?.kind).toBe('latest');

      scrollHeight = 1_400;
      await act(async () => {
        renderer?.update(createElement(Probe, { waiting: false, version: 3 }));
      });
      await act(async () => runFrames());
      expect(transcript.scrollTop).toBe(1_400);

      transcript.scrollTop = 900;
      await act(async () => {
        dispatch('wheel', { deltaY: -100 } as WheelEvent);
        dispatch('scroll');
        renderer?.update(createElement(Probe, { waiting: false, version: 4 }));
      });
      await act(async () => runFrames());
      expect(transcript.scrollTop).toBe(900);
      expect(controls.awayFromLatest).toBe(true);
      expect(controls.scrollCommand).toBeUndefined();
      expect(oldTailCommand?.signal.aborted).toBe(true);
      await act(async () => {
        renderer?.update(
          createElement(Probe, { waiting: false, version: 4, id: 'session-2' }),
        );
      });
      expect(controls.scrollCommand?.kind).toBe('latest');
      await act(async () => {
        renderer?.update(createElement(Probe, { waiting: false, version: 4 }));
      });
      expect(controls.scrollCommand?.kind).toBe('latest');
      // No persistence is enabled here: inspectors still receive all inputs.
      await act(async () => {
        dispatch('touchstart', {
          touches: [{ clientY: 100 }],
        } as unknown as TouchEvent);
        dispatch('touchmove', {
          touches: [{ clientY: 200 }],
        } as unknown as TouchEvent);
      });
      expect(controls.scrollCommand).toBeUndefined();
      await act(async () => controls.jumpToLatest());
      await act(async () => {
        windowListeners.get('keydown')?.({
          code: 'Home',
          target: null,
        } as unknown as KeyboardEvent);
      });
      expect(controls.scrollCommand).toBeUndefined();
      expect(controls.tailReadySessionId).toBe('session-1');
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});
