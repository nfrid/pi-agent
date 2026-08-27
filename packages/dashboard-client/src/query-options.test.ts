import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  type DashboardHttpClient,
  DashboardProtocolMismatchError,
} from './http-client.js';
import {
  archiveThreadMutationOptions,
  commandMutationOptions,
  createThreadMutationOptions,
  dashboardQueryKeys,
  delegateHistoryQueryOptions,
  delegateHistoryRunQueryOptions,
  pinThreadMutationOptions,
  regenerateThreadTitleMutationOptions,
  renameSessionMutationOptions,
  restartRuntimeMutationOptions,
  restoreThreadMutationOptions,
  settingsQueryOptions,
  settleThreadMutationOptions,
  snapshotQueryOptions,
  snapshotRequestGeneration,
  startRuntimeMutationOptions,
  stopRuntimeMutationOptions,
  unpinThreadMutationOptions,
  unsettleThreadMutationOptions,
  updateSettingsMutationOptions,
  usageHistoryQueryOptions,
} from './query-options.js';
import { DashboardLiveStore } from './store.js';

const client = {
  snapshot: vi.fn(),
  request: vi.fn(),
} as unknown as DashboardHttpClient;

describe('dashboard query and mutation factories', () => {
  it('queries and updates typed dashboard settings with refreshes', async () => {
    const settings = vi.fn(async () => ({ modelDisplayPreferences: {} }));
    const options = settingsQueryOptions({
      settings,
    } as unknown as DashboardHttpClient);
    expect(options.queryKey).toEqual(['dashboard', 'settings']);
    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchOnWindowFocus).toBe(true);
    if (!options.queryFn) throw new Error('Query function is missing.');
    await expect(
      options.queryFn({ signal: undefined } as never),
    ).resolves.toEqual({
      modelDisplayPreferences: {},
    });
    expect(settings).toHaveBeenCalledWith(undefined);

    const updateSettings = vi.fn(async (value: unknown) => value);
    const mutation = updateSettingsMutationOptions({
      updateSettings,
    } as unknown as DashboardHttpClient);
    if (!mutation.mutationFn) throw new Error('Mutation function is missing.');
    await expect(
      mutation.mutationFn({ modelDisplayPreferences: {} }, undefined as never),
    ).resolves.toEqual({ modelDisplayPreferences: {} });
    expect(updateSettings).toHaveBeenCalledWith({
      modelDisplayPreferences: {},
    });
  });

  it('refreshes open usage history views once a minute', async () => {
    const usageHistory = vi.fn(async () => ({
      range: '24h' as const,
      generatedAt: 1,
      series: [],
    }));
    const options = usageHistoryQueryOptions(
      { usageHistory } as unknown as DashboardHttpClient,
      '24h',
      100,
    );
    expect(options.queryKey).toEqual([
      'dashboard',
      'usage-history',
      '24h',
      100,
    ]);
    expect(options.refetchInterval).toBe(60_000);
    if (!options.queryFn) throw new Error('Query function is missing.');
    await expect(
      options.queryFn({ signal: undefined } as never),
    ).resolves.toEqual({ range: '24h', generatedAt: 1, series: [] });
    expect(usageHistory).toHaveBeenCalledWith('24h', 100);
  });

  it('queries persisted delegate history by session ID', async () => {
    const delegateHistory = vi.fn(async () => ({
      version: 2 as const,
      sessionId: 'session-1',
      groups: [],
    }));
    const options = delegateHistoryQueryOptions(
      { delegateHistory } as unknown as DashboardHttpClient,
      'session-1',
    );
    expect(options.queryKey).toEqual([
      'dashboard',
      'delegate-history',
      'session-1',
    ]);
    if (!options.queryFn) throw new Error('Query function is missing.');
    await expect(
      options.queryFn({ signal: undefined } as never),
    ).resolves.toEqual({
      version: 2,
      sessionId: 'session-1',
      groups: [],
    });
    expect(delegateHistory).toHaveBeenCalledWith('session-1', undefined);
  });

  it('keys one delegate detail by session, lineage, run, and leaf', async () => {
    const delegateHistoryRun = vi.fn(async () => ({
      version: 1 as const,
      sessionId: 'session-1',
      lineageId: 'lineage-1',
      runId: 'run-1',
      leafId: 'leaf-1',
      run: {
        runId: 'run-1',
        lineageId: 'lineage-1',
        name: 'Worker',
        kind: 'background' as const,
        state: 'success' as const,
        createdAt: 1,
        allowWrites: false,
        details: { truncated: false },
      },
    }));
    const options = delegateHistoryRunQueryOptions(
      { delegateHistoryRun } as unknown as DashboardHttpClient,
      'session-1',
      'lineage-1',
      'run-1',
      'leaf-1',
    );
    expect(options.queryKey).toEqual([
      'dashboard',
      'delegate-history-detail',
      'session-1',
      'run',
      'lineage-1',
      'run-1',
      'leaf-1',
    ]);
    expect(options.queryKey.slice(0, 3)).toEqual([
      'dashboard',
      'delegate-history-detail',
      'session-1',
    ]);
    expect(options.queryKey).not.toEqual(
      expect.arrayContaining(['delegate-history', 'session-1']),
    );
    if (!options.queryFn) throw new Error('Query function is missing.');
    await expect(
      options.queryFn({ signal: undefined } as never),
    ).resolves.toEqual(expect.objectContaining({ runId: 'run-1' }));
    expect(delegateHistoryRun).toHaveBeenCalledWith(
      'session-1',
      'run-1',
      { lineageId: 'lineage-1', leafId: 'leaf-1' },
      undefined,
    );
  });

  it('switches detail runs through separate cached queries without refetching A', async () => {
    const calls: string[] = [];
    const delegateHistoryRun = vi.fn(
      async (_sessionId: string, runId: string) => {
        calls.push(runId);
        return {
          version: 1 as const,
          sessionId: 'session-1',
          lineageId: 'lineage-1',
          runId,
          leafId: 'leaf-1',
          run: {
            runId,
            lineageId: 'lineage-1',
            name: 'Worker',
            kind: 'background' as const,
            state: 'success' as const,
            createdAt: 1,
            allowWrites: false,
            details: { response: `detail-${runId}`, truncated: false },
          },
        };
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const query = (runId: string) =>
      queryClient.fetchQuery(
        delegateHistoryRunQueryOptions(
          { delegateHistoryRun } as unknown as DashboardHttpClient,
          'session-1',
          'lineage-1',
          runId,
          'leaf-1',
        ),
      );

    await query('run-a');
    await query('run-b');
    await query('run-a');
    expect(calls).toEqual(['run-a', 'run-b']);

    // Summary settlement refreshes do not invalidate cached detail payloads.
    await queryClient.invalidateQueries({
      queryKey: dashboardQueryKeys.delegateHistory('session-1'),
    });
    await query('run-a');
    expect(calls).toEqual(['run-a', 'run-b']);
  });

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

  it('reuses one command ID when a network retry reruns the mutation', async () => {
    const sendCommand = vi.fn(async (_runtimeId: string, command: unknown) => ({
      command,
    }));
    const options = commandMutationOptions({
      sendCommand,
    } as unknown as DashboardHttpClient);
    if (!options.mutationFn) throw new Error('Mutation function is missing.');
    const variables = {
      runtimeId: 'runtime-1',
      command: { type: 'abort' },
    };
    const mutationFn = options.mutationFn as unknown as (
      value: typeof variables,
    ) => Promise<unknown>;
    await mutationFn(variables);
    await mutationFn(variables);
    const first = sendCommand.mock.calls[0]?.[1] as { id?: string };
    const second = sendCommand.mock.calls[1]?.[1] as { id?: string };
    expect(first.id).toBeTruthy();
    expect(second.id).toBe(first.id);
  });

  it('reuses one lifecycle command ID across retry attempts', async () => {
    const startRuntime = vi.fn(async (value: unknown) => value);
    const renameSession = vi.fn(async (...value: unknown[]) => value);
    const stopRuntime = vi.fn(async (...value: unknown[]) => value);
    const restartRuntime = vi.fn(async (...value: unknown[]) => value);
    const start = startRuntimeMutationOptions({
      startRuntime,
    } as unknown as DashboardHttpClient);
    const rename = renameSessionMutationOptions({
      renameSession,
    } as unknown as DashboardHttpClient);
    const stop = stopRuntimeMutationOptions({
      stopRuntime,
    } as unknown as DashboardHttpClient);
    const restart = restartRuntimeMutationOptions({
      restartRuntime,
    } as unknown as DashboardHttpClient);
    const startVariables = {
      projectId: 'project-1',
      checkoutId: 'checkout-1',
    };
    const renameVariables = { id: 'session-1', name: 'Renamed' };
    const stopVariables = { runtimeId: 'runtime-1', force: true };
    const restartVariables = { runtimeId: 'runtime-1' };
    for (const [mutation, variables] of [
      [start, startVariables],
      [rename, renameVariables],
      [stop, stopVariables],
      [restart, restartVariables],
    ] as const) {
      if (!mutation.mutationFn)
        throw new Error('Mutation function is missing.');
      await (mutation.mutationFn as (value: unknown) => Promise<unknown>)(
        variables,
      );
      await (mutation.mutationFn as (value: unknown) => Promise<unknown>)(
        variables,
      );
    }
    const firstStart = startRuntime.mock.calls[0]?.[0] as {
      commandId?: string;
    };
    const secondStart = startRuntime.mock.calls[1]?.[0] as {
      commandId?: string;
    };
    expect(firstStart.commandId).toEqual(expect.any(String));
    expect(secondStart.commandId).toBe(firstStart.commandId);
    const renameCalls = renameSession.mock.calls as unknown as Array<unknown[]>;
    const stopCalls = stopRuntime.mock.calls as unknown as Array<unknown[]>;
    const restartCalls = restartRuntime.mock.calls as unknown as Array<
      unknown[]
    >;
    expect(renameCalls[1]?.[2]).toBe(renameCalls[0]?.[2]);
    expect(stopCalls[1]?.[2]).toBe(stopCalls[0]?.[2]);
    expect(restartCalls[1]?.[1]).toBe(restartCalls[0]?.[1]);
  });

  it('reuses lifecycle command IDs and honors explicit IDs for thread controls', async () => {
    const archiveThread = vi.fn(async (...value: unknown[]) => value);
    const restoreThread = vi.fn(async (...value: unknown[]) => value);
    const regenerateThreadTitle = vi.fn(async (...value: unknown[]) => value);
    const pinThread = vi.fn(async (...value: unknown[]) => value);
    const unpinThread = vi.fn(async (...value: unknown[]) => value);
    const settleThread = vi.fn(async (...value: unknown[]) => value);
    const unsettleThread = vi.fn(async (...value: unknown[]) => value);
    const mutations = [
      [archiveThreadMutationOptions({ archiveThread } as never), archiveThread],
      [restoreThreadMutationOptions({ restoreThread } as never), restoreThread],
      [
        regenerateThreadTitleMutationOptions({
          regenerateThreadTitle,
        } as never),
        regenerateThreadTitle,
      ],
      [pinThreadMutationOptions({ pinThread } as never), pinThread],
      [unpinThreadMutationOptions({ unpinThread } as never), unpinThread],
      [settleThreadMutationOptions({ settleThread } as never), settleThread],
      [
        unsettleThreadMutationOptions({ unsettleThread } as never),
        unsettleThread,
      ],
    ] as const;
    const variables = { threadId: 'thread-1' };
    for (const [options, calls] of mutations) {
      if (!options.mutationFn) throw new Error('Mutation function is missing.');
      const mutation = options.mutationFn as (
        value: typeof variables,
      ) => Promise<unknown>;
      await mutation(variables);
      await mutation(variables);
      const first = calls.mock.calls[0]?.[1] as { commandId?: string };
      const second = calls.mock.calls[1]?.[1] as { commandId?: string };
      expect(first.commandId).toEqual(expect.any(String));
      expect(second.commandId).toBe(first.commandId);
      const explicit = { threadId: 'thread-1', commandId: 'caller-id' };
      await (
        options.mutationFn as (value: typeof explicit) => Promise<unknown>
      )(explicit);
      expect(
        (calls.mock.calls[2]?.[1] as { commandId?: string }).commandId,
      ).toBe('caller-id');
    }
  });

  it('retries runtime commands only for network failures', () => {
    const lifecycleRetry = renameSessionMutationOptions(client).retry;
    expect(typeof lifecycleRetry).toBe('function');
    expect(
      (lifecycleRetry as (count: number, error: unknown) => boolean)(0, {
        kind: 'network',
      }),
    ).toBe(true);
    expect(
      (lifecycleRetry as (count: number, error: unknown) => boolean)(0, {
        kind: 'domain',
      }),
    ).toBe(false);
    expect(
      (lifecycleRetry as (count: number, error: unknown) => boolean)(0, {
        kind: 'authentication',
      }),
    ).toBe(false);
    const retry = commandMutationOptions(client).retry;
    expect(typeof retry).toBe('function');
    expect(
      (retry as (count: number, error: unknown) => boolean)(0, {
        kind: 'network',
      }),
    ).toBe(true);
    expect(
      (retry as (count: number, error: unknown) => boolean)(1, {
        kind: 'network',
      }),
    ).toBe(true);
    expect(
      (retry as (count: number, error: unknown) => boolean)(2, {
        kind: 'network',
      }),
    ).toBe(false);
    expect(
      (retry as (count: number, error: unknown) => boolean)(0, {
        kind: 'domain',
      }),
    ).toBe(false);
    expect(
      (retry as (count: number, error: unknown) => boolean)(0, {
        kind: 'authentication',
      }),
    ).toBe(false);
    expect(typeof startRuntimeMutationOptions(client).retry).toBe('function');
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

  it('retries finite queries only for bounded network failures', () => {
    const retry = snapshotQueryOptions(client).retry;
    expect(typeof retry).toBe('function');
    const shouldRetry = retry as (count: number, error: unknown) => boolean;
    expect(shouldRetry(0, { kind: 'network' })).toBe(true);
    expect(shouldRetry(1, { kind: 'network' })).toBe(true);
    expect(shouldRetry(2, { kind: 'network' })).toBe(false);
    expect(shouldRetry(0, { status: 401 })).toBe(false);
    expect(shouldRetry(0, new DashboardProtocolMismatchError(1, 2))).toBe(
      false,
    );
    expect(shouldRetry(0, { status: 500 })).toBe(false);
    expect(shouldRetry(0, { kind: 'domain' })).toBe(false);
    expect(shouldRetry(0, { kind: 'malformed-output' })).toBe(false);
    expect(shouldRetry(0, { kind: 'request' })).toBe(false);
    expect(shouldRetry(0, new Error('unknown failure'))).toBe(false);
  });
});
