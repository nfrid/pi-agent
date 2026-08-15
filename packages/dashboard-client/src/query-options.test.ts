import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  type DashboardHttpClient,
  DashboardProtocolMismatchError,
} from './http-client.js';
import {
  activeDelegateTranscriptQueryOptions,
  commandMutationOptions,
  composerCommandsQueryOptions,
  createThreadMutationOptions,
  dashboardQueryKeys,
  delegateHistoryQueryOptions,
  delegateHistoryRunQueryOptions,
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
  it('creates workspace-scoped composer command queries', async () => {
    const composerCommands = vi.fn(async () => ({ commands: [] }));
    const options = composerCommandsQueryOptions(
      { composerCommands } as unknown as DashboardHttpClient,
      'workspace-1',
    );
    expect(options.queryKey).toEqual([
      'dashboard',
      'composer-commands',
      'workspace-1',
    ]);
    expect(options.staleTime).toBe(30_000);
    if (!options.queryFn) throw new Error('Query function is missing.');
    await expect(
      options.queryFn({ signal: undefined } as never),
    ).resolves.toEqual({
      commands: [],
    });
    expect(composerCommands).toHaveBeenCalledWith('workspace-1', undefined);
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

  it('queries the bounded active delegate transcript baseline', async () => {
    const activeDelegateTranscripts = vi.fn(async () => ({
      version: 1 as const,
      serverId: 'server-1',
      cursor: 4,
      sessionId: 'session-1',
      runs: [],
    }));
    const options = activeDelegateTranscriptQueryOptions(
      { activeDelegateTranscripts } as unknown as DashboardHttpClient,
      'session-1',
    );
    expect(options.queryKey).toEqual([
      'dashboard',
      'active-delegate-transcripts',
      'session-1',
    ]);
    if (!options.queryFn) throw new Error('Query function is missing.');
    await expect(
      options.queryFn({ signal: undefined } as never),
    ).resolves.toEqual({
      version: 1,
      serverId: 'server-1',
      cursor: 4,
      sessionId: 'session-1',
      runs: [],
    });
    expect(activeDelegateTranscripts).toHaveBeenCalledWith(
      'session-1',
      undefined,
    );
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

  it('retries runtime commands only for network failures', () => {
    expect(renameSessionMutationOptions(client).retry).toBe(false);
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

  it('does not retry authentication or protocol mismatch failures', () => {
    const retry = snapshotQueryOptions(client).retry;
    expect(typeof retry).toBe('function');
    const shouldRetry = retry as (count: number, error: unknown) => boolean;
    expect(shouldRetry(0, { status: 401 })).toBe(false);
    expect(shouldRetry(0, new DashboardProtocolMismatchError(1, 2))).toBe(
      false,
    );
    expect(shouldRetry(0, { status: 500 })).toBe(true);
    expect(shouldRetry(0, { kind: 'malformed-output' })).toBe(true);
  });
});
