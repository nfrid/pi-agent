import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  artifactProducer,
  putArtifact,
  resolveArtifact,
  restoreArtifacts,
} from '../shared/artifacts';
import { liveExtensionSurfaceHub } from '../shared/runtime/live-surfaces';
import type { DelegateConfig } from './config';
import * as configModule from './config';
import delegate, { DELEGATES_COMMAND_DESCRIPTION } from './index';
import * as sessionModule from './session';
import type { PreparedDelegateTask } from './task-lifecycle';
import * as taskLifecycle from './task-lifecycle';
import { createRun, type DelegatedRun } from './types';

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

type Handler = (...args: unknown[]) => unknown;

let artifactRoot: string;

const config: DelegateConfig = {
  timeoutMs: 60_000,
  maxParallelTasks: 2,
  maxConcurrency: 2,
  provider: 'test',
  modelCatalog: {
    quick: {
      model: 'test-model',
      thinking: 'low',
      relativeCost: 1,
      useFor: 'cheap checks',
      avoid: 'judgement calls',
    },
  },
};

function prepared(
  task = 'inspect independently',
  token = 'continuation-token',
): PreparedDelegateTask {
  return {
    plan: {
      name: `${task} agent`,
      task,
      requestedCwd: '/tmp/project',
      context: 'fresh',
      writeRequested: false,
      isolation: 'shared',
      routeOverride: false,
      warnings: [],
      routing: {
        route: 'quick',
        provider: 'test',
        model: 'test-model',
        thinking: 'low',
        relativeCost: 1,
      },
    },
    session: {
      token,
      filePath: '/tmp/delegate.jsonl',
      cwd: '/tmp/project',
      isolation: 'shared',
    },
    cwd: '/tmp/project',
    allowWrites: false,
    isolation: 'shared',
    warnings: [],
  };
}

function successfulRun(): DelegatedRun {
  const run = createRun('inspect independently', undefined, {
    continuation: 'continuation-token',
  });
  run.exitCode = 0;
  run.state = 'success';
  run.finishedAt = Date.now();
  run.messages = [
    {
      role: 'assistant',
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
      content: [{ type: 'text', text: 'Background finding.' }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  ];
  return run;
}

beforeEach(() => {
  artifactRoot = mkdtempSync(path.join(tmpdir(), 'pi-delegate-async-'));
  vi.spyOn(artifactProducer, 'put').mockImplementation(
    async (_pi, _ctx, input) => ({
      handle: `art_${'a'.repeat(22)}`,
      sha256: 'a'.repeat(64),
      size: Buffer.from(input.bytes).length,
      producer: 'delegate',
      contentClass: 'delegate-output',
      creationSource: 'delegate.result',
      encoding: 'utf-8',
      lineCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  vi.spyOn(sessionModule, 'pruneDelegateSessions').mockReturnValue({
    removed: 0,
  });
});

function useRealArtifactPublication(): void {
  vi.mocked(artifactProducer.put).mockImplementation((pi, ctx, input) =>
    putArtifact(pi, ctx, input, { root: artifactRoot }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(artifactRoot, { recursive: true, force: true });
});

function createAsyncHarness() {
  vi.spyOn(configModule, 'loadDelegateConfig').mockReturnValue({
    ...config,
    maxParallelTasks: 3,
  });
  vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockImplementation(
    async (plan) => prepared(plan.task, `token-${plan.task}`),
  );
  const finishes = new Map<string, (run: DelegatedRun) => void>();
  vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockImplementation(
    (item) =>
      new Promise<DelegatedRun>((resolve) => {
        finishes.set(item.plan.task, resolve);
      }),
  );

  const handlers = new Map<string, Handler>();
  const tools = new Map<string, RegisteredTool>();
  const sendMessage = vi.fn();
  const entries: Array<{ type: string; customType?: string; data?: unknown }> =
    [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage,
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: 'custom', customType, data });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: '/tmp/project',
    hasUI: false,
    mode: 'print',
    sessionManager: {
      getSessionId: () => 'parent',
      getEntries: () => entries,
      getHeader: () => ({}),
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;

  delegate(pi);
  handlers.get('session_start')?.({}, ctx);
  const finish = (task: string) => {
    const run = successfulRun();
    run.task = task;
    run.messages[0] = {
      ...run.messages[0],
      content: [{ type: 'text', text: `${task} finding.` }],
    } as never;
    const resolve = finishes.get(task);
    if (!resolve) throw new Error(`No delegate running task ${task}.`);
    resolve(run);
  };
  return { ctx, finish, handlers, sendMessage, tools };
}

describe('async delegate extension', () => {
  test('returns a job immediately and steers its completion later', async () => {
    let finish!: (run: DelegatedRun) => void;
    vi.spyOn(configModule, 'loadDelegateConfig').mockReturnValue(config);
    vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockResolvedValue(
      prepared(),
    );
    vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockImplementation(
      () =>
        new Promise<DelegatedRun>((resolve) => {
          finish = resolve;
        }),
    );

    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const sendMessage = vi.fn();
    const setWidget = vi.fn();
    const registerMessageRenderer = vi.fn();
    let sessionId = 'parent';
    const entries: Array<{
      type: string;
      customType?: string;
      data?: unknown;
    }> = [];
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer,
      sendMessage,
      appendEntry(customType: string, data: unknown) {
        entries.push({ type: 'custom', customType, data });
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: '/tmp/project',
      hasUI: true,
      mode: 'tui',
      ui: { setWidget },
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => entries,
        getHeader: () => ({
          type: 'session',
          version: 4,
          id: 'parent',
          timestamp: new Date().toISOString(),
          cwd: '/tmp/project',
        }),
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;

    useRealArtifactPublication();
    delegate(pi);
    const completionRenderer = registerMessageRenderer.mock.calls[0]?.[1] as
      | ((
          message: { content: string; details: unknown },
          options: { expanded: boolean },
          theme: { fg: (color: string, text: string) => string },
        ) => { render: (width: number) => string[] })
      | undefined;
    const completedJob = {
      id: 'dj-1',
      name: 'Independent inspection',
      mode: 'single',
      state: 'success',
      tasks: ['inspect'],
      createdAt: 1_000,
      startedAt: 2_000,
      settledAt: 7_000,
      route: 'quick',
    };
    const compactCompletion =
      completionRenderer?.(
        {
          content: `First line\n\n${'long output '.repeat(40)}`,
          details: { jobs: [completedJob] },
        },
        { expanded: false },
        { fg: (_color, text) => text },
      )
        .render(200)
        .join('\n') ?? '';
    expect(compactCompletion.split('\n')).toHaveLength(1);
    expect(compactCompletion).toContain(
      '✓ Background subagent Independent inspection · finished · 5s',
    );
    expect(compactCompletion).not.toContain('First line');
    expect(compactCompletion.startsWith(' ')).toBe(true);

    const expandedCompletion =
      completionRenderer?.(
        {
          content: 'hidden handoff',
          details: {
            jobs: [
              completedJob,
              {
                ...completedJob,
                id: 'dj-2',
                name: 'Second inspection',
                state: 'error',
              },
            ],
          },
        },
        { expanded: true },
        { fg: (_color, text) => text },
      )
        .render(200)
        .join('\n') ?? '';
    expect(expandedCompletion).toContain(
      '2 background subagents finished · 1 succeeded, 1 failed',
    );
    expect(expandedCompletion).toContain('dj-1 · quick · 5s');
    expect(expandedCompletion).toContain('Second inspection');
    expect(expandedCompletion).not.toContain('hidden handoff');

    const failedBatch =
      completionRenderer?.(
        {
          content: 'hidden failures',
          details: {
            jobs: [
              { ...completedJob, state: 'error' },
              { ...completedJob, id: 'dj-2', state: 'error' },
            ],
          },
        },
        { expanded: false },
        { fg: (_color, text) => text },
      )
        .render(200)
        .join('\n') ?? '';
    expect(failedBatch).toContain(
      '✗ 2 background subagents finished · 2 failed',
    );

    const timedOutCompletion =
      completionRenderer?.(
        {
          content: 'hidden timeout',
          details: {
            jobs: [
              {
                ...completedJob,
                state: 'error',
                runs: [{ state: 'timed-out' }],
              },
            ],
          },
        },
        { expanded: false },
        { fg: (_color, text) => text },
      )
        .render(200)
        .join('\n') ?? '';
    expect(timedOutCompletion).toContain('◷');
    expect(timedOutCompletion).toContain('timed out');

    handlers.get('session_start')?.({}, ctx);
    const delegateTool = tools.get('delegate');
    expect(delegateTool).toBeDefined();
    expect(tools.has('delegate_jobs')).toBe(true);

    const launch = await delegateTool?.execute(
      'call-1',
      {
        name: 'Independent inspection',
        task: 'inspect independently',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(launch?.content[0]?.text).toContain(
      'Started 1 background delegate job: dj-1',
    );
    expect(launch?.content[0]?.text).toContain(
      'if none remains, briefly tell the user you are waiting for the background delegate and will resume automatically, then end the turn.',
    );
    expect(launch?.content[0]?.text).not.toContain(
      'if none remains, end the turn.',
    );
    expect(launch?.content[0]?.text).not.toContain('peek to wait');
    expect(launch?.content[0]?.text).toContain('continuation-token');
    expect(sendMessage).not.toHaveBeenCalled();

    finish(successfulRun());
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: 'delegate-job-result',
      content: expect.stringContaining('Delegated results: 1 run(s)'),
      display: true,
    });
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({
      deliverAs: 'steer',
      triggerTurn: true,
    });
    const widgetFactory = setWidget.mock.calls.find(
      (call) => typeof call[1] === 'function',
    )?.[1] as
      | ((
          tui: unknown,
          theme: { fg: (color: string, text: string) => string },
        ) => { render: (width: number) => string[] })
      | undefined;
    const widget = widgetFactory?.(
      { requestRender: vi.fn() },
      { fg: (_color, text) => text },
    );
    expect(widget?.render(100).join('\n')).toContain('done');

    // The completion was queued during an existing turn, so that settlement
    // cannot arm cleanup before the automatic delivery is processed.
    handlers.get('agent_settled')?.({}, ctx);
    expect(widget?.render(100).join('\n')).toContain('done');

    handlers.get('context')?.({
      messages: [sendMessage.mock.calls[0]?.[0]],
    });
    handlers.get('agent_settled')?.({}, ctx);
    expect(widget?.render(100).join('\n')).toContain('done');
    expect(
      (
        liveExtensionSurfaceHub
          .snapshot()
          .find((surface) => surface.rendererId === 'delegate.status')
          ?.viewModel as { statuses?: unknown[] } | undefined
      )?.statuses,
    ).toHaveLength(1);

    handlers.get('input')?.(
      { source: 'interactive', streamingBehavior: 'steer' },
      ctx,
    );
    handlers.get('input')?.({ source: 'extension' }, ctx);
    expect(widget?.render(100).join('\n')).toContain('done');

    handlers.get('input')?.({ source: 'interactive' }, ctx);
    expect(widget?.render(100)).toEqual([]);
    expect(
      (
        liveExtensionSurfaceHub
          .snapshot()
          .find((surface) => surface.rendererId === 'delegate.status')
          ?.viewModel as { statuses?: unknown[] } | undefined
      )?.statuses,
    ).toEqual([]);
    const peek = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-2',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(peek?.content[0]?.text).not.toContain('Background finding.');
    const peekDetails = peek?.details as {
      job?: {
        runs?: Array<{ artifact?: { handle?: string; size?: number } }>;
      };
    };
    const handle = peekDetails.job?.runs?.[0]?.artifact?.handle;
    expect(handle).toBeDefined();
    expect(entries).toHaveLength(1);

    sessionId = 'foreign';
    handlers.get('session_tree')?.({}, ctx);
    const foreignPeek = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-foreign-peek',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(foreignPeek?.content[0]?.text).not.toContain(`Artifact: ${handle}`);
    expect(
      (
        foreignPeek?.details as {
          job?: { runs?: Array<{ artifact?: unknown }> };
        }
      ).job?.runs?.[0]?.artifact,
    ).toBeUndefined();
    expect(entries).toHaveLength(1);

    sessionId = 'parent';
    const ownerPeek = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-owner-peek',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(ownerPeek?.content[0]?.text).toContain(`Artifact: ${handle}`);
    expect(ownerPeek?.content[0]?.text).toContain(
      'Delegated results: 1 run(s)',
    );

    sessionId = 'foreign';
    handlers.get('session_tree')?.({}, ctx);
    const foreignList = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-foreign-list',
        { action: 'list' },
        undefined,
        undefined,
        ctx,
      );
    const foreignListedJob = (
      foreignList?.details as {
        jobs?: Array<{
          runs?: Array<{ artifact?: unknown }>;
          handoff?: string;
        }>;
      }
    ).jobs?.[0];
    expect(foreignListedJob?.runs?.[0]?.artifact).toBeUndefined();
    expect(foreignListedJob?.handoff).toBeUndefined();

    const foreignCancelled = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-foreign-cancel',
        { action: 'cancel', ids: ['dj-1'] },
        undefined,
        undefined,
        ctx,
      );
    expect(foreignCancelled?.content[0]?.text).not.toContain(
      'Delegated results: 1 run(s)',
    );
    const foreignCancelledJob = (
      foreignCancelled?.details as {
        jobs?: Array<{
          runs?: Array<{ artifact?: unknown }>;
          handoff?: string;
        }>;
      }
    ).jobs?.[0];
    expect(foreignCancelledJob?.runs?.[0]?.artifact).toBeUndefined();
    expect(foreignCancelledJob?.handoff).toBeUndefined();

    sessionId = 'parent';
    const ownerList = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-owner-list',
        { action: 'list' },
        undefined,
        undefined,
        ctx,
      );
    const ownerListedJob = (
      ownerList?.details as {
        jobs?: Array<{
          runs?: Array<{ artifact?: { handle?: string } }>;
          handoff?: string;
        }>;
      }
    ).jobs?.[0];
    expect(ownerListedJob?.runs?.[0]?.artifact?.handle).toBe(handle);
    expect(ownerListedJob?.handoff).toContain('Delegated results: 1 run(s)');

    rmSync(artifactRoot, { recursive: true, force: true });
    expect(
      await resolveArtifact(ctx, handle as string, artifactRoot),
    ).toBeUndefined();
    expect(await restoreArtifacts(ctx, artifactRoot)).toBe(1);
    expect(
      (
        await resolveArtifact(ctx, handle as string, artifactRoot)
      )?.bytes.toString(),
    ).toBe('Background finding.');
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('removes pre-flush terminal results but suppresses a queued automatic handoff', async () => {
    vi.useFakeTimers();
    const { ctx, finish, handlers, sendMessage, tools } = createAsyncHarness();
    const launch = await tools.get('delegate')?.execute(
      'call-batch',
      {
        tasks: [
          { name: 'First agent', task: 'first', route: 'quick' },
          { name: 'Second agent', task: 'second', route: 'quick' },
          { name: 'Third agent', task: 'third', route: 'quick' },
        ],
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(launch?.content[0]?.text).toContain('dj-1, dj-2, dj-3');

    finish('first');
    finish('second');
    finish('third');
    await vi.advanceTimersByTimeAsync(0);

    const peek = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-peek',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(peek?.details).toMatchObject({
      action: 'peek',
      job: { id: 'dj-1' },
    });
    const cancelled = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-cancel',
        { action: 'cancel', ids: ['dj-2'] },
        undefined,
        undefined,
        ctx,
      );
    expect(cancelled?.details).toMatchObject({
      action: 'cancel',
      jobs: [{ id: 'dj-2', state: 'success' }],
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0].details).toMatchObject({
      jobs: [{ id: 'dj-3' }],
    });

    // sendMessage has accepted the steer, but its custom message has not yet
    // entered context. A terminal peek must not duplicate the handoff.
    const queuedPeek = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-queued-peek',
        { action: 'peek', id: 'dj-3' },
        undefined,
        undefined,
        ctx,
      );
    expect(queuedPeek?.content[0]?.text).toContain('already queued');
    expect(queuedPeek?.content[0]?.text).not.toContain('third finding');
    expect(queuedPeek?.details).toMatchObject({
      action: 'peek',
      delivery: 'automatic-queued',
      job: {
        id: 'dj-3',
        state: 'success',
        handoff: expect.stringContaining('Truncation: original report omitted'),
      },
    });
    const queuedCancel = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-queued-cancel',
        { action: 'cancel', ids: ['dj-3'] },
        undefined,
        undefined,
        ctx,
      );
    expect(queuedCancel?.content[0]?.text).toContain('already queued');
    expect(queuedCancel?.details).toMatchObject({
      action: 'cancel',
      delivery: 'automatic-queued',
      automaticQueuedJobIds: ['dj-3'],
      jobs: [
        {
          id: 'dj-3',
          handoff: expect.stringContaining(
            'Truncation: original report omitted',
          ),
        },
      ],
    });

    handlers.get('context')?.({
      messages: [sendMessage.mock.calls[0]?.[0]],
    });
    const deliveredPeek = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-delivered-peek',
        { action: 'peek', id: 'dj-3' },
        undefined,
        undefined,
        ctx,
      );
    expect(deliveredPeek?.content[0]?.text).not.toContain('third finding.');
    expect(deliveredPeek?.details).toMatchObject({
      action: 'peek',
      job: { id: 'dj-3', state: 'success' },
    });
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('rolls back queued delivery state when sendMessage throws', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, finish, handlers, sendMessage, tools } = createAsyncHarness();
    sendMessage.mockImplementation(() => {
      throw new Error('send failed');
    });
    await tools.get('delegate')?.execute(
      'call-failed-send',
      {
        name: 'First agent',
        task: 'first',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    finish('first');
    await vi.advanceTimersByTimeAsync(50);
    const peek = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-after-failed-send',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(peek?.content[0]?.text).not.toContain('first finding.');
    expect(peek?.details).not.toHaveProperty('delivery');
    expect(error).toHaveBeenCalledWith(
      'delegate: failed to deliver background completion',
      expect.any(Error),
    );
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('restores explicit inspection when an accepted steer never enters context', async () => {
    vi.useFakeTimers();
    const { ctx, finish, handlers, tools } = createAsyncHarness();
    await tools.get('delegate')?.execute(
      'call-lost-steer',
      {
        name: 'First agent',
        task: 'first',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    finish('first');
    await vi.advanceTimersByTimeAsync(50);

    // Production sendMessage reports asynchronous dispatch failure internally.
    // With no queued continuation left, agent_settled is the observable signal
    // that the automatic custom message will not enter context.
    handlers.get('agent_settled')?.({}, ctx);
    const peek = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-after-lost-steer',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(peek?.content[0]?.text).not.toContain('first finding.');
    expect(peek?.details).not.toHaveProperty('delivery');
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('keeps automatic delivery for nonterminal peeks but not waiting peeks', async () => {
    vi.useFakeTimers();
    const { ctx, finish, handlers, sendMessage, tools } = createAsyncHarness();
    await tools.get('delegate')?.execute(
      'call-first',
      {
        name: 'First agent',
        task: 'first',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    const nonterminal = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-nonterminal-peek',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(nonterminal?.details).toMatchObject({
      action: 'peek',
      job: { id: 'dj-1', state: 'running' },
    });
    finish('first');
    await vi.advanceTimersByTimeAsync(50);
    expect(sendMessage.mock.calls[0]?.[0].details).toMatchObject({
      jobs: [{ id: 'dj-1' }],
    });

    await tools.get('delegate')?.execute(
      'call-second',
      {
        name: 'Second agent',
        task: 'second',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    const waiting = tools
      .get('delegate_jobs')
      ?.execute(
        'call-waiting-peek',
        { action: 'peek', id: 'dj-2', wait_seconds: 1 },
        undefined,
        undefined,
        ctx,
      );
    finish('second');
    await expect(waiting).resolves.toMatchObject({
      details: { action: 'peek', job: { id: 'dj-2', state: 'success' } },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendMessage).toHaveBeenCalledOnce();
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('delivers staggered jobs in partial completion waves', async () => {
    vi.spyOn(configModule, 'loadDelegateConfig').mockReturnValue({
      ...config,
      maxParallelTasks: 3,
    });
    vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockImplementation(
      async (plan) => prepared(plan.task, `token-${plan.task}`),
    );
    const finishes = new Map<string, (run: DelegatedRun) => void>();
    vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockImplementation(
      (item) =>
        new Promise<DelegatedRun>((resolve) => {
          finishes.set(item.plan.task, resolve);
        }),
    );

    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const sendMessage = vi.fn();
    const entries: Array<{
      type: string;
      customType?: string;
      data?: unknown;
    }> = [];
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage,
      appendEntry(customType: string, data: unknown) {
        entries.push({ type: 'custom', customType, data });
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: '/tmp/project',
      hasUI: false,
      mode: 'print',
      sessionManager: {
        getSessionId: () => 'parent',
        getEntries: () => entries,
        getHeader: () => ({}),
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;

    delegate(pi);
    handlers.get('session_start')?.({}, ctx);
    const launch = await tools.get('delegate')?.execute(
      'call-batch',
      {
        tasks: [
          { name: 'First agent', task: 'first', route: 'quick' },
          { name: 'Second agent', task: 'second', route: 'quick' },
          { name: 'Third agent', task: 'third', route: 'quick' },
        ],
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(launch?.content[0]?.text).toContain(
      'Started 3 background delegate jobs: dj-1, dj-2, dj-3',
    );

    const first = successfulRun();
    first.task = 'first';
    first.messages[0] = {
      ...first.messages[0],
      content: [{ type: 'text', text: 'First finding.' }],
    } as never;
    finishes.get('first')?.(first);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(sendMessage).not.toHaveBeenCalled();

    const listed = await tools
      .get('delegate_jobs')
      ?.execute('call-list', { action: 'list' }, undefined, undefined, ctx);
    expect((listed?.details as { jobs?: unknown[] })?.jobs).toHaveLength(3);

    const second = successfulRun();
    second.task = 'second';
    second.messages[0] = {
      ...second.messages[0],
      content: [{ type: 'text', text: 'Second finding.' }],
    } as never;
    finishes.get('second')?.(second);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage.mock.calls[0]?.[0].content).not.toContain(
      'First finding.',
    );
    expect(sendMessage.mock.calls[0]?.[0].content).not.toContain(
      'Second finding.',
    );
    expect(sendMessage.mock.calls[0]?.[0].content).not.toContain(
      'Third finding.',
    );

    const third = successfulRun();
    third.task = 'third';
    third.messages[0] = {
      ...third.messages[0],
      content: [{ type: 'text', text: 'Third finding.' }],
    } as never;
    finishes.get('third')?.(third);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1]?.[0].content).not.toContain(
      'Third finding.',
    );
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('shows live activity and suppresses delivery after tree navigation', async () => {
    const configLoader = vi
      .spyOn(configModule, 'loadDelegateConfig')
      .mockReturnValue(config);
    vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockResolvedValue(
      prepared(),
    );
    let finish!: (run: DelegatedRun) => void;
    vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockImplementation(
      (task, options) => {
        const live = createRun(task.plan.task, task.plan.routing, {
          name: task.plan.name,
        });
        live.state = 'running';
        live.startedAt = Date.now();
        live.activities.push({
          type: 'tool',
          label: 'bash npm test -- --changed',
          status: 'running',
        });
        options.onUpdate?.({
          content: [{ type: 'text', text: 'running' }],
          details: { mode: 'single', runs: [live] },
        });
        return new Promise<DelegatedRun>((resolve) => {
          finish = resolve;
        });
      },
    );

    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    >();
    const sendMessage = vi.fn();
    const notify = vi.fn();
    const setWidget = vi.fn();
    const entries: Array<{
      type: string;
      customType?: string;
      data?: unknown;
    }> = [];
    let sessionId = 'parent';
    const getCommands = vi.fn(() => [
      {
        name: 'delegates',
        description: DELEGATES_COMMAND_DESCRIPTION,
        sourceInfo: { path: '/extensions/delegate/index.ts' },
      },
    ]);
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        },
      ) {
        commands.set(name, definition);
      },
      registerMessageRenderer: vi.fn(),
      sendMessage,
      getCommands,
      appendEntry(customType: string, data: unknown) {
        entries.push({ type: 'custom', customType, data });
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: '/tmp/project',
      hasUI: true,
      mode: 'tui',
      ui: { notify, setWidget },
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => entries,
        getHeader: () => ({}),
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;

    useRealArtifactPublication();
    delegate(pi);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain('Comparison: unavailable');
    expect(notify.mock.calls[0]?.[0]).toContain(
      '/reload establishes prompt guidance',
    );
    notify.mockClear();
    handlers.get('session_start')?.({}, ctx);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Comparison: same'),
      'info',
    );
    expect(notify.mock.calls[0]?.[0]).toContain(
      'Extension source: /extensions/delegate/index.ts',
    );
    getCommands.mockReturnValue([
      {
        name: 'delegates',
        description: DELEGATES_COMMAND_DESCRIPTION,
        sourceInfo: { path: '/one.ts' },
      },
      {
        name: 'delegates',
        description: DELEGATES_COMMAND_DESCRIPTION,
        sourceInfo: { path: '/two.ts' },
      },
    ]);
    notify.mockClear();
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain('Extension source: unknown');
    notify.mockClear();
    getCommands.mockReturnValue([
      {
        name: 'delegates',
        description: DELEGATES_COMMAND_DESCRIPTION,
        sourceInfo: { path: '/extensions/delegate/index.ts' },
      },
    ]);
    const invalidConfig: DelegateConfig = {
      ...config,
      error: 'delegate.timeoutMs must be an integer between 10000 and 3600000.',
    };
    configLoader.mockReturnValue(invalidConfig);
    handlers.get('session_start')?.({}, ctx);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain('Comparison: same');
    expect(notify.mock.calls[0]?.[0]).toContain('valid=no');
    expect(notify.mock.calls[0]?.[0]).toContain(
      'Current settings: fingerprint=',
    );
    expect(notify.mock.calls[0]?.[0]).toContain('valid=no; routes=');
    expect(notify.mock.calls[0]?.[0]).toContain(
      'Fix current settings before delegating; delegate execution is unavailable with current settings.',
    );
    expect(notify.mock.calls[0]?.[0]).not.toContain(
      'Prompt guidance is current.',
    );
    notify.mockClear();
    configLoader.mockReturnValue(config);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain(
      '/reload refreshes prompt guidance. Delegate execution re-reads current settings on demand.',
    );
    notify.mockClear();
    handlers.get('session_start')?.({}, ctx);
    configLoader.mockReturnValue(invalidConfig);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain(
      'Fix current settings before delegating; delegate execution is unavailable with current settings.',
    );
    expect(notify.mock.calls[0]?.[0]).not.toContain(
      'Prompt guidance is current',
    );
    notify.mockClear();
    configLoader.mockReturnValue({ ...config, timeoutMs: 120_000 });
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Comparison: differs'),
      'info',
    );
    expect(notify.mock.calls[0]?.[0]).toContain(
      '/reload refreshes prompt guidance',
    );
    notify.mockClear();
    await commands.get('delegates')?.handler('unexpected', ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Unknown /delegates argument'),
      'error',
    );
    notify.mockClear();
    configLoader.mockReturnValue(config);
    await tools.get('delegate')?.execute(
      'call-1',
      {
        name: 'Independent inspection',
        task: 'inspect independently',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    const widgetFactory = [...setWidget.mock.calls]
      .reverse()
      .find((call) => typeof call[1] === 'function')?.[1] as
      | ((
          tui: unknown,
          theme: { fg: (color: string, text: string) => string },
        ) => { render: (width: number) => string[] })
      | undefined;
    const requestRender = vi.fn();
    const widget = widgetFactory?.(
      { requestRender },
      { fg: (_color, text) => text },
    );
    const widgetLines = widget?.render(100) ?? [];
    expect(widgetLines).toHaveLength(2);
    expect(widgetLines[0]).toContain('● inspect independently agent');
    expect(widgetLines[0]).toMatch(/\d+s$/);
    expect(widgetLines[1]).toContain('bash npm test -- --changed');
    expect(widgetLines.join('\n')).not.toMatch(
      /\b(?:Tool|Reasoning|Now|Last)\b/,
    );

    handlers.get('agent_start')?.({}, ctx);
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(
      setWidget.mock.calls.filter((call) => typeof call[1] === 'function'),
    ).toHaveLength(1);

    requestRender.mockClear();
    await commands.get('delegates')?.handler('', ctx);
    const compactFactory = [...setWidget.mock.calls]
      .reverse()
      .find(
        (call) => typeof call[1] === 'function',
      )?.[1] as typeof widgetFactory;
    const compactLine = widget?.render(100)[0] ?? '';
    expect(compactFactory).toBe(widgetFactory);
    expect(compactLine).toContain('1 subagent');
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(
      setWidget.mock.calls.filter((call) => typeof call[1] === 'function'),
    ).toHaveLength(1);
    expect(compactLine).not.toContain('inspect independently');
    expect(notify).not.toHaveBeenCalled();

    sessionId = 'branch';
    handlers.get('session_tree')?.({}, ctx);
    finish(successfulRun());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);

    expect(notify.mock.calls[0]?.[0]).toContain('another conversation branch');

    sessionId = 'parent';
    await commands.get('delegates')?.handler('', ctx);
    const foreground = tools.get('delegate')?.execute(
      'call-foreground',
      {
        name: 'Foreground audit',
        task: 'audit in the foreground',
        route: 'quick',
      },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => {
      const factory = [...setWidget.mock.calls]
        .reverse()
        .find((call) => typeof call[1] === 'function')?.[1] as
        | typeof widgetFactory
        | undefined;
      const output =
        factory?.(
          { requestRender: vi.fn() },
          { fg: (_color, text) => text },
        ).render(100) ?? [];
      expect(output.join('\n')).toContain('inspect independently agent');
      expect(output.join('\n')).toContain('bash npm test -- --changed');
    });
    sessionId = 'branch';
    finish(successfulRun());
    const foregroundResult = await foreground;
    expect(foregroundResult?.content[0]?.text).toContain(
      'Inline fallback (artifact unavailable)',
    );
    expect(entries).toHaveLength(0);
    handlers.get('agent_settled')?.({}, ctx);
    const afterSettlement =
      widgetFactory?.(
        { requestRender: vi.fn() },
        { fg: (_color, text: string) => text },
      ).render(100) ?? [];
    expect(afterSettlement.join('\n')).toContain('Subagent');

    handlers.get('input')?.({ source: 'rpc' }, ctx);
    const afterNextUserMessage =
      widgetFactory?.(
        { requestRender: vi.fn() },
        { fg: (_color, text: string) => text },
      ).render(100) ?? [];
    // The earlier stale run shares this continuation lineage and has not been
    // inspected yet, so neither run in the lineage is eligible for cleanup.
    expect(afterNextUserMessage.join('\n')).toContain('Subagent');

    const crossBranch = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-cross-branch-peek',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(crossBranch?.content[0]?.text).not.toContain('Artifact:');
    expect(crossBranch?.details).toMatchObject({
      action: 'peek',
      job: { runs: [{ task: 'inspect independently' }] },
    });
    const crossBranchJob = (
      crossBranch?.details as { job?: { runs?: Array<{ artifact?: unknown }> } }
    ).job;
    expect(crossBranchJob?.runs?.[0]?.artifact).toBeUndefined();
    expect(entries).toHaveLength(0);

    sessionId = 'parent';
    const entriesBeforeInspected = entries.length;
    const inspected = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-stale-peek',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(inspected?.details).toMatchObject({
      action: 'peek',
      job: { runs: [{ artifact: { contentClass: 'delegate-output' } }] },
    });
    expect(entries).toHaveLength(entriesBeforeInspected + 1);

    await tools
      .get('delegate_jobs')
      ?.execute(
        'call-peek-stale',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    handlers.get('agent_settled')?.({}, ctx);
    expect(
      widgetFactory?.(
        { requestRender: vi.fn() },
        { fg: (_color, text) => text },
      ).render(100),
    ).not.toEqual([]);
    handlers.get('input')?.({ source: 'interactive' }, ctx);
    expect(
      widgetFactory?.(
        { requestRender: vi.fn() },
        { fg: (_color, text) => text },
      ).render(100),
    ).toEqual([]);

    vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockRejectedValueOnce(
      new Error('unexpected delegate failure'),
    );
    const failedForeground = await tools.get('delegate')?.execute(
      'call-failing-foreground',
      {
        name: 'Failing foreground audit',
        task: 'fail unexpectedly',
        route: 'quick',
      },
      undefined,
      undefined,
      ctx,
    );
    expect(failedForeground?.details).toMatchObject({
      runs: [
        {
          lifecycle: { reason: 'provider-runner-error' },
        },
      ],
    });
    expect(
      widgetFactory?.(
        { requestRender: vi.fn() },
        { fg: (_color, text) => text },
      )
        .render(100)
        .join('\n'),
    ).toContain('failed');
    await handlers.get('session_shutdown')?.({}, ctx);
  });
});
