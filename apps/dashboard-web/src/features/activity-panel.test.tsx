import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useActivityPanelState } from './activity-panel';

const PIN_KEY = 'pi-dashboard-activity-panel-pinned-v1';

type MediaListener = (event: MediaQueryListEvent) => void;

let wide = false;
const mediaListeners = new Set<MediaListener>();
const stored = new Map<string, string>();
const setItem = (...args: [string, string]) => {
  stored.set(...args);
};
const media = {
  get matches() {
    return wide;
  },
  addEventListener: (_type: string, listener: MediaListener) => {
    if (typeof listener === 'function') mediaListeners.add(listener);
  },
  removeEventListener: (_type: string, listener: MediaListener) => {
    if (typeof listener === 'function') mediaListeners.delete(listener);
  },
} as MediaQueryList;
const fakeWindow = Object.assign(new EventTarget(), {
  matchMedia: () => media,
  localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem },
});

function setWide(value: boolean) {
  wide = value;
  const event = new Event('change') as MediaQueryListEvent;
  for (const listener of mediaListeners) listener(event);
}

function runtimeWithSurfaces(extensionSurfaces: readonly unknown[]) {
  return {
    runtimeId: 'runtime-1',
    liveState: 'idle',
    cwd: '/tmp',
    session: { id: 'session-1', entries: [] },
    extensionSurfaces,
  } as never as RuntimeSnapshot;
}

let latest: ReturnType<typeof useActivityPanelState>;
function Probe({ runtime }: { runtime: RuntimeSnapshot | undefined }) {
  latest = useActivityPanelState(runtime);
  return null;
}

describe('activity panel state', () => {
  beforeEach(() => {
    wide = false;
    mediaListeners.clear();
    stored.clear();
    Object.assign(globalThis, { window: fakeWindow });
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('keeps a stored pin preference through mobile-first responsive changes', () => {
    stored.set(PIN_KEY, 'true');
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(<Probe runtime={undefined} />);
    });

    expect(latest.pinned).toBe(false);
    expect(latest.open).toBe(false);
    expect(stored.get(PIN_KEY)).toBe('true');

    act(() => setWide(true));
    expect(latest.isWide).toBe(true);
    expect(latest.pinned).toBe(true);
    expect(latest.open).toBe(true);
    expect(stored.get(PIN_KEY)).toBe('true');

    act(() => latest.togglePinned());
    expect(latest.pinned).toBe(false);
    expect(latest.open).toBe(false);
    expect(stored.get(PIN_KEY)).toBe('false');

    act(() => setWide(false));
    act(() => setWide(true));
    expect(latest.pinned).toBe(false);
    expect(latest.open).toBe(false);
    act(() => renderer?.unmount());
  });

  it('marks only unfinished tasks and queued or running delegates as active', () => {
    const terminal = runtimeWithSurfaces([
      {
        id: 'tasks.current',
        rendererId: 'tasks.current',
        viewModel: {
          version: 1,
          tasks: [
            {
              id: 'done',
              text: 'Done',
              status: 'done',
              dependsOn: [],
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'dropped',
              text: 'Dropped',
              status: 'dropped',
              dependsOn: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          stats: { total: 2, active: 0, done: 1, blocked: 0, ready: 0 },
        },
      },
      {
        id: 'delegate.status',
        rendererId: 'delegate.status',
        viewModel: {
          version: 1,
          statuses: [
            {
              id: 'finished',
              runId: 'finished',
              lineageId: 'finished',
              name: 'Finished',
              kind: 'background',
              state: 'success',
              createdAt: 1,
              allowWrites: false,
            },
          ],
        },
      },
    ]);
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(<Probe runtime={terminal} />);
    });
    expect(latest.hints).toEqual({ tasks: false, delegates: false });

    const active = runtimeWithSurfaces([
      {
        id: 'tasks.current',
        rendererId: 'tasks.current',
        viewModel: {
          version: 1,
          tasks: [
            {
              id: 'todo',
              text: 'Todo',
              status: 'todo',
              dependsOn: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          stats: { total: 1, active: 1, done: 0, blocked: 0, ready: 1 },
        },
      },
      {
        id: 'delegate.status',
        rendererId: 'delegate.status',
        viewModel: {
          version: 1,
          statuses: [
            {
              id: 'queued',
              runId: 'queued',
              lineageId: 'queued',
              name: 'Queued',
              kind: 'background',
              state: 'queued',
              createdAt: 1,
              allowWrites: false,
            },
          ],
        },
      },
    ]);
    act(() => renderer?.update(<Probe runtime={active} />));
    expect(latest.hints).toEqual({ tasks: true, delegates: true });
    act(() => renderer?.unmount());
  });
});
