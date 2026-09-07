import type { TranscriptProjection } from '@pi-dashboard/domain';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  distanceFromScrollEnd,
  FOLLOW_REARM_DISTANCE_PX,
  nextFollowMode,
  readSessionScrollMemory,
  useSessionScroll,
} from './scroll';

function memory(mode: 'following' | 'manual', extra = {}) {
  return JSON.stringify({ version: 1, mode, scrollTop: 420, ...extra });
}

function installWindow(values: Map<string, string>) {
  const listeners = new Map<string, Set<EventListener>>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const fakeWindow = {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    addEventListener: (type: string, listener: EventListener) => {
      const set = listeners.get(type) ?? new Set<EventListener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListener) =>
      listeners.get(type)?.delete(listener),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout,
    clearTimeout,
    innerHeight: 800,
    visualViewport: undefined,
  };
  vi.stubGlobal('window', fakeWindow);
  return {
    dispatch(type: string, event = new Event(type)) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    runFrames() {
      for (const [id, callback] of frames) {
        frames.delete(id);
        callback(0);
      }
    },
  };
}

function transcriptElement() {
  const listeners = new Map<string, Set<EventListener>>();
  const element = {
    scrollHeight: 1_000,
    scrollTop: 0,
    clientHeight: 100,
    addEventListener: (type: string, listener: EventListener) => {
      const set = listeners.get(type) ?? new Set<EventListener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListener) =>
      listeners.get(type)?.delete(listener),
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [],
    dispatch(type: string, event = new Event(type)) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  } as unknown as HTMLDivElement & {
    dispatch: (type: string, event?: Event) => void;
  };
  return element;
}

describe('session scroll memory storage', () => {
  it('isolates server sessions and ignores corrupt values', () => {
    const values = new Map<string, string>([
      [
        'pi.dashboard.session-scroll.v1:server-a:session-1',
        memory('manual', { rowKey: 'message-4', rowOffset: 18 }),
      ],
      [
        'pi.dashboard.session-scroll.v1:server-b:session-1',
        memory('following'),
      ],
    ]);
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    try {
      expect(readSessionScrollMemory('session-1', 'server-a')?.rowKey).toBe(
        'message-4',
      );
      expect(readSessionScrollMemory('session-1', 'server-b')?.mode).toBe(
        'following',
      );
      values.set('pi.dashboard.session-scroll.v1:server-a:broken', '{bad');
      expect(readSessionScrollMemory('broken', 'server-a')).toBeUndefined();
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

describe('session follow policy', () => {
  it('keeps the pure rearm boundary explicit', () => {
    expect(FOLLOW_REARM_DISTANCE_PX).toBe(40);
    expect(nextFollowMode('manual', 41, false)).toBe('manual');
    expect(nextFollowMode('manual', 40, false)).toBe('following');
    expect(nextFollowMode('following', 0, true)).toBe('manual');
    expect(distanceFromScrollEnd(1_000, 600, 300)).toBe(100);
  });

  it('does not rearm manual reading from programmatic bottom scroll', async () => {
    const values = new Map([
      ['pi.dashboard.session-scroll.v1:server-a:session-1', memory('manual')],
    ]);
    const browser = installWindow(values);
    const transcript = transcriptElement();
    const scrollElementRef = { current: transcript };
    let controls!: ReturnType<typeof useSessionScroll>;
    function Probe({ id = 'session-1' }: { id?: string }) {
      controls = useSessionScroll({
        id,
        serverId: 'server-a',
        data: { entries: ['entry'] },
        projection: {} as TranscriptProjection,
        sessionMounted: true,
        enabled: true,
        scrollElementRef,
      });
      return null;
    }
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Probe));
      });
      expect(controls.restoring).toBe(true);
      await act(async () => controls.completeRestore());
      transcript.scrollTop = 900;
      await act(async () => transcript.dispatch('scroll'));
      expect(controls.modeRef.current).toBe('manual');
      expect(controls.tailScrollRequest).toBe(0);
      await act(async () => controls.jumpToLatest());
      await act(async () => browser.runFrames());
      expect(transcript.scrollTop).toBe(1_000);
      expect(controls.modeRef.current).toBe('following');
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('finishes a failed older-history restore without following', async () => {
    const values = new Map([
      [
        'pi.dashboard.session-scroll.v1:server-a:session-1',
        memory('manual', { oldestOrdinal: 0 }),
      ],
    ]);
    installWindow(values);
    const transcript = transcriptElement();
    const loadThroughOrdinal = vi.fn().mockResolvedValue(false);
    let controls!: ReturnType<typeof useSessionScroll>;
    function Probe() {
      controls = useSessionScroll({
        id: 'session-1',
        serverId: 'server-a',
        history: { start: 10, hasOlder: true },
        historyAvailable: true,
        loadThroughOrdinal,
        data: { entries: ['entry'] },
        projection: {} as TranscriptProjection,
        sessionMounted: true,
        enabled: true,
        scrollElementRef: { current: transcript },
      });
      return null;
    }
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Probe));
      });
      await vi.waitFor(() =>
        expect(loadThroughOrdinal).toHaveBeenCalledWith(0),
      );
      expect(controls.restoring).toBe(true);
      await act(async () => controls.completeRestore());
      expect(controls.restoring).toBe(false);
      expect(controls.modeRef.current).toBe('manual');
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});
