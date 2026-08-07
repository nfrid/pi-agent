import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardHttpClient } from './http-client.js';
import {
  commandMutationOptions,
  createThreadMutationOptions,
  renameSessionMutationOptions,
  snapshotQueryOptions,
  snapshotRequestGeneration,
  startRuntimeMutationOptions,
} from './query-options.js';
import { DashboardLiveStore } from './store.js';

const client = {
  snapshot: vi.fn(),
  request: vi.fn(),
} as unknown as DashboardHttpClient;

describe('dashboard query and mutation factories', () => {
  it('keeps the live baseline authoritative and does not expire snapshots', () => {
    expect(snapshotQueryOptions(client).staleTime).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('allocates one stable command ID per orchestration mutation call', async () => {
    const createThread = vi.fn(async () => ({}) as never);
    const mutationClient = { createThread } as unknown as DashboardHttpClient;
    const options = createThreadMutationOptions(mutationClient);
    if (!options.mutationFn) throw new Error('Mutation function is missing.');
    await (
      options.mutationFn as unknown as (value: unknown) => Promise<unknown>
    )({
      projectId: 'project-1',
      command: { title: 'Thread', prompt: 'Prompt' },
    });
    const calls = createThread.mock.calls as unknown as Array<
      [string, { commandId?: string }]
    >;
    const command = calls[0]?.[1];
    expect(command.commandId).toBeTruthy();
    expect(createThread).toHaveBeenCalledOnce();
  });

  it('never retries prompt, command, launch, or rename mutations', () => {
    expect(renameSessionMutationOptions(client).retry).toBe(false);
    expect(commandMutationOptions(client).retry).toBe(false);
    expect(startRuntimeMutationOptions(client).retry).toBe(false);
  });

  it('rejects a stale snapshot query after an SSE generation replacement', async () => {
    const store = new DashboardLiveStore();
    const first = {
      serverId: 'daemon-a',
      revision: 1,
      cursor: 1,
      runtimes: [],
      workspaces: [],
      sessions: [],
      unread: [],
    } as unknown as BrowserSnapshot;
    const replacement = { ...first, serverId: 'daemon-b', cursor: 1 };
    store.installSnapshot(first);
    let resolveSnapshot!: (value: BrowserSnapshot) => void;
    client.snapshot = vi.fn(
      () =>
        new Promise<BrowserSnapshot>((resolve) => (resolveSnapshot = resolve)),
    );
    const query = snapshotQueryOptions(client, () => store.getGeneration());
    if (!query.queryFn) throw new Error('Snapshot query function is missing.');
    const pending = query.queryFn({} as never);
    store.installSnapshot(replacement, { source: 'sse' });
    resolveSnapshot(first);
    const stale = await pending;
    expect(
      store.installSnapshot(stale, {
        source: 'http',
        requestGeneration: snapshotRequestGeneration(stale),
      }),
    ).toBe(false);
    expect(store.getSnapshot().serverId).toBe('daemon-b');
  });

  it('does not retry authentication failures in fetch queries', () => {
    const retry = snapshotQueryOptions(client).retry;
    expect(typeof retry).toBe('function');
    expect(
      (retry as (count: number, error: unknown) => boolean)(0, { status: 401 }),
    ).toBe(false);
    expect(
      (retry as (count: number, error: unknown) => boolean)(0, { status: 500 }),
    ).toBe(true);
  });
});
