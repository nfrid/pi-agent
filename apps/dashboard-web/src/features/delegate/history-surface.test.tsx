import { DashboardLiveStore, dashboardHttpClient } from '@pi-dashboard/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegateHistorySurface } from './history-surface';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

afterEach(() => vi.restoreAllMocks());

function renderHistorySurface(client: QueryClient) {
  return create(
    <QueryClientProvider client={client}>
      <DelegateHistorySurface
        id="session-1"
        runtime={undefined}
        sessionChange={0}
        store={new DashboardLiveStore()}
      />
    </QueryClientProvider>,
  );
}

describe('delegate history surface visibility', () => {
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
