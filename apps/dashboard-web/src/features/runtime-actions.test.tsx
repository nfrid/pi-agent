import { dashboardQueryKeys } from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  DurableThreadActions,
  refreshDurableThreadMetadata,
  runtimeLifecycleActionAvailability,
} from './runtime-actions';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function runtime(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    runtimeId: 'runtime-1',
    ownership: 'external',
    pid: 1,
    cwd: '/tmp/project',
    liveState: 'working',
    online: true,
    session: { id: 'session-1', entries: [] },
    ...overrides,
  } as RuntimeSnapshot;
}

describe('runtime lifecycle action availability', () => {
  it('refreshes durable thread state after runtime lifecycle changes', async () => {
    const client = new QueryClient();
    const invalidate = vi
      .spyOn(client, 'invalidateQueries')
      .mockResolvedValue(undefined);

    await refreshDurableThreadMetadata(client);

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: dashboardQueryKeys.threads(),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: dashboardQueryKeys.sessionThreadLinks(),
    });
  });

  it('renders durable lifecycle controls and disables archive for active runs', () => {
    const client = new QueryClient();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <QueryClientProvider client={client}>
          <DurableThreadActions
            title="Durable thread"
            closeMenu={vi.fn()}
            thread={{
              threadId: 'thread-1',
              pinnedAt: 10,
              hasActiveRun: true,
            }}
          />
        </QueryClientProvider>,
      );
    });

    const buttons = tree.root.findAllByType('button');
    expect(buttons.map((button) => button.children.join(' '))).toEqual([
      'Unpin',
      'Archive',
    ]);
    expect(buttons[1]?.props.disabled).toBe(true);
    act(() => tree.unmount());
  });

  it('offers graceful stop without exposing force stop initially', () => {
    expect(runtimeLifecycleActionAvailability(runtime())).toEqual({
      canStop: true,
      canRestart: false,
      canForceStop: false,
    });
  });

  it('only exposes force stop after failure or an explicit stopping state', () => {
    expect(runtimeLifecycleActionAvailability(runtime(), true)).toEqual({
      canStop: false,
      canRestart: false,
      canForceStop: true,
    });
    expect(
      runtimeLifecycleActionAvailability(runtime({ liveState: 'stopping' })),
    ).toEqual({ canStop: false, canRestart: false, canForceStop: true });
  });

  it('keeps restart available for managed runtimes, including offline ones', () => {
    expect(
      runtimeLifecycleActionAvailability(
        runtime({ ownership: 'managed', online: false }),
      ),
    ).toEqual({ canStop: false, canRestart: true, canForceStop: false });
  });
});
