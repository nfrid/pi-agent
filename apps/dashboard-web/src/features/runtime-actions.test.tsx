import { dashboardHttpClient, dashboardQueryKeys } from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  DurableThreadActions,
  QuickSettleThreadAction,
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

  it('invokes the quick settle action without navigating the row', async () => {
    const client = new QueryClient();
    const settle = vi
      .spyOn(dashboardHttpClient, 'settleThread')
      .mockResolvedValue({ id: 'thread-1' } as never);
    const stopPropagation = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <QueryClientProvider client={client}>
          <QuickSettleThreadAction
            threadId="thread-1"
            title="Finished thread"
          />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      tree.root.findByType('button').props.onClick({ stopPropagation });
    });

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith('thread-1', expect.anything());
    act(() => tree.unmount());
    settle.mockRestore();
  });

  it('renders and invokes Settle, while archived rows do not offer it', async () => {
    const client = new QueryClient();
    const settle = vi
      .spyOn(dashboardHttpClient, 'settleThread')
      .mockResolvedValue({ id: 'thread-1' } as never);
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <QueryClientProvider client={client}>
          <DurableThreadActions
            title="Durable thread"
            closeMenu={vi.fn()}
            thread={{ threadId: 'thread-1', hasActiveRun: true }}
          />
        </QueryClientProvider>,
      );
    });
    const settleButton = tree.root
      .findAllByType('button')
      .find((button) => button.children.join(' ') === 'Settle');
    expect(settleButton).toBeDefined();
    await act(async () => {
      settleButton?.props.onClick({ stopPropagation: vi.fn() });
    });
    expect(settle).toHaveBeenCalledWith('thread-1', expect.anything());
    act(() => tree.unmount());
    settle.mockRestore();

    act(() => {
      tree = create(
        <QueryClientProvider client={client}>
          <DurableThreadActions
            title="Settled thread"
            closeMenu={vi.fn()}
            thread={{
              threadId: 'thread-1',
              settledAt: 20,
              hasActiveRun: false,
            }}
          />
        </QueryClientProvider>,
      );
    });
    expect(
      tree.root
        .findAllByType('button')
        .some((button) => button.children.join(' ') === 'Unsettle'),
    ).toBe(true);
    act(() => tree.unmount());

    act(() => {
      tree = create(
        <QueryClientProvider client={client}>
          <DurableThreadActions
            title="Archived thread"
            closeMenu={vi.fn()}
            thread={{
              threadId: 'thread-1',
              archivedAt: 10,
              settledAt: 20,
              hasActiveRun: false,
            }}
          />
        </QueryClientProvider>,
      );
    });
    expect(
      tree.root.findAllByType('button').map((item) => item.children.join(' ')),
    ).not.toEqual(expect.arrayContaining(['Settle', 'Unsettle']));
    act(() => tree.unmount());
  });

  it('regenerates a durable thread title from its action menu', async () => {
    const client = new QueryClient();
    const regenerate = vi
      .spyOn(dashboardHttpClient, 'regenerateThreadTitle')
      .mockResolvedValue({ id: 'thread-1', title: 'New title' } as never);
    const closeMenu = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <QueryClientProvider client={client}>
          <DurableThreadActions
            title="Durable thread"
            closeMenu={closeMenu}
            thread={{ threadId: 'thread-1', hasActiveRun: true }}
          />
        </QueryClientProvider>,
      );
    });
    const button = tree.root
      .findAllByType('button')
      .find((item) => item.children.join(' ') === 'Regenerate title');

    await act(async () => {
      button?.props.onClick({ stopPropagation: vi.fn() });
    });

    expect(regenerate).toHaveBeenCalledWith('thread-1', expect.anything());
    expect(closeMenu).toHaveBeenCalledOnce();
    act(() => tree.unmount());
    regenerate.mockRestore();
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
    const labels = buttons.map((button) => button.children.join(' '));
    expect(labels).toContain('Unpin');
    expect(labels).toContain('Settle');
    expect(labels).toContain('Regenerate title');
    expect(
      buttons.find((button) => button.children.join(' ') === 'Archive')?.props
        .disabled,
    ).toBe(true);
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
