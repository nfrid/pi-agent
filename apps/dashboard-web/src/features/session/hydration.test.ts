import { DashboardLiveStore } from '@pi-dashboard/client';
import type { AuthoritativeSessionSnapshot } from '@pi-dashboard/protocol';
import { createElement, StrictMode } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useSessionHydration } from './hydration';

const response: AuthoritativeSessionSnapshot = {
  serverId: 'server-1',
  cursor: 0,
  metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
  entries: [],
  entriesComplete: true,
  active: {
    messages: [],
    tools: [],
    delegates: [],
    truncated: false,
  },
  completeThroughCursor: true,
};

function HydrationProbe({
  id = 'session-1',
  store,
  onHydration,
}: {
  id?: string;
  store: DashboardLiveStore;
  onHydration?: (value: ReturnType<typeof useSessionHydration>) => void;
}) {
  const hydration = useSessionHydration({
    id,
    store,
    onReplacement: () => undefined,
  });
  onHydration?.(hydration);
  return null;
}

describe('useSessionHydration', () => {
  it('acquires only the selected session feed and releases on route changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new DashboardLiveStore();
    const releases: string[] = [];
    const acquire = vi
      .spyOn(store, 'acquireSession')
      .mockImplementation((id) => ({
        sessionId: id,
        release: () => releases.push(id),
      }));
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(
            StrictMode,
            null,
            createElement(HydrationProbe, { id: 'session-1', store }),
          ),
        );
      });
      expect(acquire).toHaveBeenCalledWith('session-1');
      await act(async () => {
        renderer?.update(
          createElement(HydrationProbe, { id: 'session-2', store }),
        );
      });
      expect(acquire).toHaveBeenLastCalledWith('session-2');
      expect(releases).toContain('session-1');
      await act(async () => renderer?.unmount());
      expect(releases).toContain('session-2');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses feed snapshots and retries by rebasing only the selected domain', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new DashboardLiveStore();
    store.installSnapshot({
      serverId: 'server-1',
      revision: 0,
      cursor: 0,
      runtimes: [],
      sessions: [response.metadata],
      unread: [],
    });
    store.beginSessionSync('session-1', 1);
    store.acceptSessionSnapshot(response, 0, 1, true);
    vi.spyOn(store, 'acquireSession').mockReturnValue({
      sessionId: 'session-1',
      release: () => undefined,
    });
    const reconnect = vi.spyOn(store, 'reconnectSession');
    let hydration: ReturnType<typeof useSessionHydration> | undefined;
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(HydrationProbe, {
            store,
            onHydration: (value) => {
              hydration = value;
            },
          }),
        );
      });
      expect(hydration?.data?.metadata.id).toBe('session-1');
      expect(hydration?.projection).toBeDefined();
      hydration?.retrySession();
      expect(reconnect).toHaveBeenCalledOnce();
      expect(reconnect).toHaveBeenCalledWith('session-1');
      await act(async () => renderer?.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
