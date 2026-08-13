import {
  DashboardLiveStore,
  dashboardHttpClient,
  dashboardQueryKeys,
} from '@pi-dashboard/client';
import type { SessionApiResponse } from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { isCurrentSessionResponse, useSessionHydration } from './hydration';

const response: SessionApiResponse = {
  serverId: 'daemon-1',
  cursor: 1,
  metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
  entries: [],
};

function HydrationProbe({ store }: { store: DashboardLiveStore }) {
  useSessionHydration({
    id: 'session-1',
    store,
    onReplacement: () => undefined,
  });
  return null;
}

describe('isCurrentSessionResponse', () => {
  it('accepts only a response for the current session ID', () => {
    const response = { metadata: { id: 'session-a' } };

    expect(isCurrentSessionResponse('session-a', response)).toBe(true);
    expect(isCurrentSessionResponse('session-b', response)).toBe(false);
    expect(isCurrentSessionResponse('session-a', undefined)).toBe(false);
  });

  it('does not refetch active sessions for session metadata records', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const session = vi
      .spyOn(dashboardHttpClient, 'session')
      .mockResolvedValue(response);
    const store = new DashboardLiveStore();
    vi.spyOn(store, 'hydrateSession').mockReturnValue({} as never);
    store.installSnapshot({
      serverId: 'daemon-1',
      revision: 1,
      cursor: 1,
      runtimes: [
        {
          runtimeId: 'runtime-1',
          online: true,
          session: { id: 'session-1', entries: [] },
        } as never,
      ],
      workspaces: [],
      sessions: [{ ...response.metadata, activeRuntimeId: 'runtime-1' }],
      unread: [],
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(dashboardQueryKeys.session('session-1'), response);
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HydrationProbe, { store }),
          ),
        );
      });

      await act(async () => {
        for (let cursor = 2; cursor <= 21; cursor += 1)
          store.acceptStreamRecord({
            type: 'sessions',
            cursor,
            emittedAt: cursor,
            upsert: [
              {
                ...response.metadata,
                updatedAt: cursor,
              },
            ],
            remove: [],
          });
      });
      expect(store.getSnapshot().resyncNonce).toBe(0);
      expect(session).not.toHaveBeenCalled();

      await act(async () => {
        store.acceptStreamRecord({
          cursor: 22,
          emittedAt: 22,
          sessionId: 'session-1',
          event: {
            type: 'session.snapshot',
            session: {
              id: 'session-1',
              entries: [],
              entriesComplete: false,
            },
          },
        });
      });
      await expect.poll(() => session).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().sessionChangeById['session-1']).toBe(1);

      await act(async () => {
        store.acceptStreamRecord({
          cursor: 23,
          emittedAt: 23,
          runtimeId: 'runtime-1',
          sessionId: 'session-1',
          event: {
            type: 'runtime.stateChanged',
            state: 'idle',
            snapshot: {
              session: { id: 'session-1', entries: [], entriesComplete: false },
            },
          },
        });
      });
      expect(session).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      session.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('does not refetch a mounted session for metadata-only appends', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const session = vi
      .spyOn(dashboardHttpClient, 'session')
      .mockResolvedValue(response);
    const store = new DashboardLiveStore();
    vi.spyOn(store, 'hydrateSession').mockReturnValue({} as never);
    store.installSnapshot({
      serverId: 'daemon-1',
      revision: 1,
      cursor: 1,
      runtimes: [],
      workspaces: [],
      sessions: [
        {
          ...response.metadata,
          entryCount: 1,
        },
        {
          id: 'session-2',
          file: '/tmp/other.jsonl',
          cwd: '/tmp',
          updatedAt: 1,
          entryCount: 1,
        },
      ],
      unread: [],
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(dashboardQueryKeys.session('session-1'), response);
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HydrationProbe, { store }),
          ),
        );
      });

      await act(async () => {
        store.acceptStreamRecord({
          type: 'sessions',
          cursor: 2,
          emittedAt: 2,
          upsert: [
            {
              ...response.metadata,
              updatedAt: 2,
              entryCount: 2,
            },
          ],
          remove: [],
        });
      });
      expect(session).not.toHaveBeenCalled();
      expect(store.getSnapshot().sessionChangeById).toEqual({});

      await act(async () => {
        store.acceptStreamRecord({
          type: 'sessions',
          cursor: 3,
          emittedAt: 3,
          upsert: [
            {
              id: 'session-2',
              file: '/tmp/other.jsonl',
              cwd: '/tmp',
              updatedAt: 2,
              entryCount: 2,
            },
          ],
          remove: [],
        });
      });
      expect(store.getSnapshot().sessionChangeById).toEqual({});
      expect(session).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      session.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
