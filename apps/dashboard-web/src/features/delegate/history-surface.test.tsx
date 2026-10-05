import { DashboardLiveStore, dashboardHttpClient } from '@pi-dashboard/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DelegateHistorySurface,
  promoteDelegateDetailSelection,
} from './history-surface';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

afterEach(() => vi.restoreAllMocks());

function historySurfaceElement(client: QueryClient, sessionChange = 0) {
  return (
    <QueryClientProvider client={client}>
      <DelegateHistorySurface
        id="session-1"
        runtime={undefined}
        sessionChange={sessionChange}
        store={new DashboardLiveStore()}
        client={dashboardHttpClient}
      />
    </QueryClientProvider>
  );
}

function renderHistorySurface(client: QueryClient, sessionChange = 0) {
  return create(historySurfaceElement(client, sessionChange));
}

describe('delegate history surface visibility', () => {
  it('uses the current summary leaf when a selected live run becomes durable', () => {
    const liveSelection = {
      sessionId: 'session-1',
      lineageId: 'lineage-1',
      runId: 'run-1',
      liveRunId: 'run-1',
      settlementKey: 'run-1',
      shouldFetch: false,
    };
    expect(
      promoteDelegateDetailSelection(liveSelection, 'leaf-terminal'),
    ).toMatchObject({ leafId: 'leaf-terminal', shouldFetch: true });

    const durableSelection = {
      ...liveSelection,
      leafId: 'leaf-selected',
      shouldFetch: true,
    };
    expect(
      promoteDelegateDetailSelection(durableSelection, 'leaf-revision'),
    ).toBe(durableSelection);
  });
  it('queues a trailing query refresh for revisions during an in-flight fetch', async () => {
    let resolveFirst!: (value: never) => void;
    let resolveSecond!: (value: never) => void;
    const first = new Promise<never>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<never>((resolve) => {
      resolveSecond = resolve;
    });
    const request = vi
      .spyOn(dashboardHttpClient, 'delegateHistory')
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = renderHistorySurface(client);
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledTimes(1);

    for (let revision = 1; revision <= 8; revision += 1) {
      await act(async () => {
        tree.update(historySurfaceElement(client, revision));
      });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 125));
    });
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ groups: [], leafId: 'leaf-1', truncated: false } as never);
      await first;
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveSecond({
        groups: [],
        leafId: 'leaf-1',
        truncated: false,
      } as never);
      await second;
      tree.unmount();
    });
    client.clear();
  });

  it('stays hidden while empty history is loading', () => {
    vi.spyOn(dashboardHttpClient, 'delegateHistory').mockReturnValue(
      new Promise(() => {}),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = renderHistorySurface(client);
    });

    expect(tree.toJSON()).toBeNull();
    act(() => tree.unmount());
  });

  it('stays hidden when empty history cannot be loaded', async () => {
    vi.spyOn(dashboardHttpClient, 'delegateHistory').mockRejectedValue(
      new Error('offline'),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = renderHistorySurface(client);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(tree.toJSON()).toBeNull();
    act(() => tree.unmount());
  });
});
