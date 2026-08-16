import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { requestRuntimePause, resumeRuntimePause } from '../pause/operations';
import { getPauseCoordinator } from '../pause/state';
import {
  artifactProducer,
  putArtifact,
  resolveArtifact,
  restoreArtifacts,
} from '../shared/artifacts';
import { markDashboardFreshUserTurn } from '../shared/runtime/agent-lifecycle';
import { getLiveExtensionSurfaceHub } from '../shared/runtime/live-surfaces';
import { getScopedServices } from '../shared/runtime/scoped-services';
import type { DelegateConfig } from './config';
import * as configModule from './config';
import {
  createDelegateControlChannel,
  listActiveDelegateControlChannels,
} from './control';
import delegate, { DELEGATES_COMMAND_DESCRIPTION } from './index';
import { setDelegateLifecycle } from './lifecycle';
import * as sessionModule from './session';
import type { PreparedDelegateTask } from './task-lifecycle';
import * as taskLifecycle from './task-lifecycle';
import { createRun, type DelegatedRun } from './types';
import { WAKE_RELOAD_ORPHAN_REASON } from './wake-coordinator';
import * as worktreeModule from './worktree';

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
    runId: 'run-test',
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
      sessionId: `session-${token}`,
      lineageId: `lineage-${token}`,
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

function failedRun(): DelegatedRun {
  const run = createRun('inspect independently', undefined, {
    continuation: 'continuation-token',
  });
  run.exitCode = 7;
  run.state = 'error';
  setDelegateLifecycle(
    run,
    'child-nonzero-exit',
    `owner diagnostic ${'x'.repeat(3_000)}`,
  );
  return run;
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

async function createAsyncHarness(
  initialScope = 'parent',
  restored?: {
    entries: Array<{
      type: string;
      customType?: string;
      data?: unknown;
      message?: unknown;
    }>;
    leafId?: string;
  },
) {
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
  const activeTools = new Set(['delegate', 'artifact_retrieve']);
  const sendMessage = vi.fn();
  const eventListeners = new Map<string, Set<(value: unknown) => void>>();
  const entries: Array<{
    type: string;
    customType?: string;
    data?: unknown;
    message?: unknown;
  }> = restored ? [...restored.entries] : [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools.clear();
      for (const name of names) activeTools.add(name);
    },
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage,
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: 'custom', customType, data });
    },
    events: {
      on(event: string, listener: (value: unknown) => void) {
        const listeners = eventListeners.get(event) ?? new Set();
        listeners.add(listener);
        eventListeners.set(event, listeners);
        return () => listeners.delete(listener);
      },
      emit(event: string, value: unknown) {
        for (const listener of eventListeners.get(event) ?? []) listener(value);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: '/tmp/project',
    hasUI: false,
    mode: 'print',
    isIdle: () => false,
    sessionManager: {
      getSessionId: () => initialScope,
      getEntries: () => entries,
      getHeader: () => ({}),
      getBranch: () => (restored ? entries : []),
      ...(restored?.leafId
        ? { getLeafId: () => restored.leafId as string }
        : {}),
    },
  } as unknown as ExtensionContext;

  delegate(pi);
  await handlers.get('session_start')?.({}, ctx);
  const finish = (task: string, supplied?: DelegatedRun) => {
    const run = supplied ?? successfulRun();
    run.task = task;
    run.messages[0] = {
      ...run.messages[0],
      content: [{ type: 'text', text: `${task} finding.` }],
    } as never;
    const resolve = finishes.get(task);
    if (!resolve) throw new Error(`No delegate running task ${task}.`);
    resolve(run);
  };
  return {
    ctx,
    pi,
    finish,
    hasFinish: (task: string) => finishes.has(task),
    handlers,
    sendMessage,
    tools,
    activeTools,
    entries,
  };
}

describe('async delegate extension', () => {
  test('state-gates broker tools until their state is actionable', async () => {
    const { ctx, finish, handlers, sendMessage, tools, activeTools } =
      await createAsyncHarness();
    expect(activeTools).toEqual(new Set(['delegate', 'artifact_retrieve']));

    await tools.get('delegate')?.execute(
      'call-gated-background',
      {
        name: 'Gated background task',
        task: 'gated',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(activeTools).toContain('delegate_jobs');
    expect(activeTools).not.toContain('delegate_branches');

    finish('gated');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('captures model WIP before an async worktree workflow barrier and releases its pin once', async () => {
    const { ctx, finish, hasFinish, handlers, tools } =
      await createAsyncHarness();
    const events: string[] = [];
    const privateRef = 'refs/private/pi-worktree-manager/wip/captured-test';
    const dispose = vi.fn(async () => {
      events.push('dispose');
    });
    vi.spyOn(worktreeModule, 'captureWorkInProgress').mockImplementation(
      async () => {
        events.push('capture');
        return {
          repositoryRoot: '/tmp/project',
          baseHead: 'a'.repeat(40),
          snapshotCommit: 'b'.repeat(40),
          carriedWip: true,
          carryCommit: 'b'.repeat(40),
          ref: privateRef,
          dispose,
        };
      },
    );
    const childPlans: Array<
      Parameters<typeof taskLifecycle.prepareDelegateTask>[0]
    > = [];
    vi.mocked(taskLifecycle.prepareDelegateTask).mockImplementation(
      async (plan) => {
        events.push(`prepare:${plan.task}`);
        if (plan.task === 'child') childPlans.push(plan);
        const item = prepared(plan.task, `token-${plan.task}`);
        return {
          ...item,
          plan,
          cwd: plan.requestedCwd,
          allowWrites: plan.writeRequested,
          isolation: plan.isolation,
          warnings: [...plan.warnings],
        };
      },
    );

    await tools
      .get('delegate')
      ?.execute(
        'gate-call',
        { id: 'gate', task: 'gate', route: 'quick' },
        undefined,
        undefined,
        ctx,
      );
    await vi.waitFor(() => expect(hasFinish('gate')).toBe(true));
    const receipt = await tools.get('delegate')?.execute(
      'child-call',
      {
        id: 'child',
        task: 'child',
        route: 'quick',
        isolation: 'worktree',
        from: 'wip',
        after: ['gate'],
      },
      undefined,
      undefined,
      ctx,
    );
    events.push('receipt');

    expect(receipt?.content[0]?.text).toContain('child@1');
    expect(events.indexOf('capture')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('capture')).toBeLessThan(events.indexOf('receipt'));
    expect(childPlans).toHaveLength(0);

    // The parent source can change after scheduling; the child still uses the
    // immutable ref captured before the dependency barrier.
    events.push('parent-changed');
    finish('gate');
    await vi.waitFor(() => expect(childPlans).toHaveLength(1));
    expect(childPlans[0]?.baseRef).toBe(privateRef);
    expect(childPlans[0]?.base).toBeUndefined();
    expect(events.indexOf('prepare:child')).toBeGreaterThan(
      events.indexOf('parent-changed'),
    );
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(events.indexOf('prepare:child')).toBeLessThan(
      events.indexOf('dispose'),
    );

    finish('child');
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    await handlers.get('session_shutdown')?.({}, ctx);
    expect(dispose).toHaveBeenCalledOnce();
  });

  test('from head skips model WIP capture', async () => {
    const { ctx, handlers, tools } = await createAsyncHarness();
    const capture = vi.spyOn(worktreeModule, 'captureWorkInProgress');
    vi.mocked(taskLifecycle.runPreparedDelegateTask).mockResolvedValue(
      successfulRun(),
    );

    await tools.get('delegate')?.execute(
      'head-call',
      {
        id: 'head-source',
        task: 'head source',
        route: 'quick',
        isolation: 'worktree',
        from: 'head',
      },
      undefined,
      undefined,
      ctx,
    );
    expect(capture).not.toHaveBeenCalled();
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('disposes a captured source when model schedule validation fails before identity admission', async () => {
    const { ctx, handlers, tools } = await createAsyncHarness();
    const privateRef = 'refs/private/pi-worktree-manager/wip/invalid-test';
    const dispose = vi.fn();
    vi.spyOn(worktreeModule, 'captureWorkInProgress').mockResolvedValue({
      repositoryRoot: '/tmp/project',
      baseHead: 'a'.repeat(40),
      snapshotCommit: 'a'.repeat(40),
      carriedWip: false,
      ref: privateRef,
      dispose,
    });

    await expect(
      tools.get('delegate')?.execute(
        'invalid-call',
        {
          id: 'invalid',
          task: 'invalid',
          route: 'quick',
          isolation: 'worktree',
          from: 'wip',
          after: ['missing-dependency'],
        },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/Unknown (?:logical ID|workflow attempt)/);
    expect(dispose).toHaveBeenCalledOnce();
    expect(getScopedServices('parent').delegateWorkflow?.get('invalid')).toBe(
      undefined,
    );
    expect(getScopedServices('parent').delegateWorkflow?.list()).toEqual([]);
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('enrolls a delegate control channel opened after pause was requested', async () => {
    const { ctx, handlers, pi } = await createAsyncHarness();
    const requested = requestRuntimePause(pi, ctx);
    const channel = createDelegateControlChannel(
      path.join(artifactRoot, 'late-delegate.jsonl'),
      'parent',
    );
    const snapshot = getPauseCoordinator('parent').snapshot();
    expect(snapshot?.generation).toBe(requested.generation);
    expect(snapshot?.delegateIds).toContain(channel.participantId);
    expect(readFileSync(channel.filePath, 'utf8')).toContain('"kind":"pause"');

    resumeRuntimePause(pi, ctx);
    expect(readFileSync(channel.filePath, 'utf8')).toContain('"kind":"resume"');
    channel.close();
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('advances two delegate rows from pausing to paused and clears them on resume', async () => {
    const { ctx, finish, handlers, pi, tools } = await createAsyncHarness();
    await tools.get('delegate')?.execute(
      'call-two-paused',
      {
        tasks: [
          { name: 'Pause one', task: 'pause one', route: 'quick' },
          { name: 'Pause two', task: 'pause two', route: 'quick' },
        ],
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );

    const requested = requestRuntimePause(pi, ctx);
    const channels = listActiveDelegateControlChannels().filter(
      (channel) => channel.ownerSessionId === 'parent',
    );
    expect(channels).toHaveLength(2);
    const pausingStatuses = (
      getLiveExtensionSurfaceHub('parent')
        .snapshot()
        .find((surface) => surface.rendererId === 'delegate.status')
        ?.viewModel as {
        statuses?: Array<{ pauseState?: string; pausedAt?: number }>;
      }
    ).statuses;
    expect(pausingStatuses).toHaveLength(2);
    expect(pausingStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pauseState: 'pausing',
          pausedAt: expect.any(Number),
        }),
        expect.objectContaining({
          pauseState: 'pausing',
          pausedAt: expect.any(Number),
        }),
      ]),
    );

    for (const channel of channels) {
      const pause = readFileSync(channel.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: string; kind: string })
        .find((request) => request.kind === 'pause');
      expect(pause).toBeDefined();
      channel.acknowledge(pause?.id ?? '', 'pause', requested.generation);
    }
    getPauseCoordinator('parent').markMainReached(requested.generation);

    expect(getPauseCoordinator('parent').snapshot()).toMatchObject({
      phase: 'paused',
      delegateIds: expect.arrayContaining(
        channels.map((channel) => channel.participantId),
      ),
      reachedDelegateIds: expect.arrayContaining(
        channels.map((channel) => channel.participantId),
      ),
    });
    const pausedStatuses = (
      getLiveExtensionSurfaceHub('parent')
        .snapshot()
        .find((surface) => surface.rendererId === 'delegate.status')
        ?.viewModel as {
        statuses?: Array<{ pauseState?: string; pausedAt?: number }>;
      }
    ).statuses;
    expect(
      pausedStatuses?.every((status) => status.pauseState === 'paused'),
    ).toBe(true);
    expect(
      pausedStatuses?.every((status) => status.pausedAt !== undefined),
    ).toBe(true);

    resumeRuntimePause(pi, ctx);
    const resumedStatuses = (
      getLiveExtensionSurfaceHub('parent')
        .snapshot()
        .find((surface) => surface.rendererId === 'delegate.status')
        ?.viewModel as {
        statuses?: Array<{ pauseState?: string; pausedAt?: number }>;
      }
    ).statuses;
    expect(
      resumedStatuses?.every(
        (status) =>
          status.pauseState === undefined && status.pausedAt === undefined,
      ),
    ).toBe(true);

    finish('pause one');
    finish('pause two');
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('binds foreground delegate controls to live pause rows', async () => {
    const { ctx, finish, handlers, pi, tools } = await createAsyncHarness();
    const execution = tools.get('delegate')?.execute(
      'call-foreground-paused',
      {
        tasks: [
          { name: 'Foreground one', task: 'foreground one', route: 'quick' },
          { name: 'Foreground two', task: 'foreground two', route: 'quick' },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() =>
      expect(
        listActiveDelegateControlChannels().filter(
          (channel) => channel.ownerSessionId === 'parent',
        ),
      ).toHaveLength(2),
    );

    requestRuntimePause(pi, ctx);
    const statuses = (
      getLiveExtensionSurfaceHub('parent')
        .snapshot()
        .find((surface) => surface.rendererId === 'delegate.status')
        ?.viewModel as {
        statuses?: Array<{ pauseState?: string; pausedAt?: number }>;
      }
    ).statuses;
    expect(statuses).toHaveLength(2);
    expect(
      statuses?.every(
        (status) =>
          status.pauseState === 'pausing' && status.pausedAt !== undefined,
      ),
    ).toBe(true);

    resumeRuntimePause(pi, ctx);
    finish('foreground one');
    finish('foreground two');
    await execution;
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('keeps an active delegate enrolled when pause delivery fails', async () => {
    const { ctx, handlers, pi } = await createAsyncHarness();
    const requested = requestRuntimePause(pi, ctx);
    const channel = createDelegateControlChannel(
      path.join(artifactRoot, 'missing', 'delegate.jsonl'),
      'parent',
      'background',
    );

    expect(channel.pause(requested.generation).accepted).toBe(false);
    expect(getPauseCoordinator('parent').snapshot()?.delegateIds).toContain(
      channel.participantId,
    );
    expect(getPauseCoordinator('parent').snapshot()?.phase).toBe('pausing');

    resumeRuntimePause(pi, ctx);
    channel.close();
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('keeps pause wiring active after a complete session replacement', async () => {
    const { ctx, handlers, pi } = await createAsyncHarness('scope-A');
    await handlers.get('session_shutdown')?.({}, ctx);
    const replacement = {
      ...ctx,
      sessionManager: {
        ...ctx.sessionManager,
        getSessionId: () => 'scope-B',
      },
    };
    await handlers.get('session_start')?.({}, replacement);
    const requested = requestRuntimePause(pi, replacement);
    const channel = createDelegateControlChannel(
      path.join(artifactRoot, 'replacement-delegate.jsonl'),
      'scope-B',
      'background',
    );

    expect(getPauseCoordinator('scope-B').snapshot()?.delegateIds).toContain(
      channel.participantId,
    );
    expect(readFileSync(channel.filePath, 'utf8')).toContain(
      `"generation":${requested.generation}`,
    );

    resumeRuntimePause(pi, replacement);
    channel.close();
    await handlers.get('session_shutdown')?.({}, replacement);
  });

  test('resumes old-scope channels after a replacement session starts', async () => {
    const { ctx, handlers, pi } = await createAsyncHarness('scope-A');
    requestRuntimePause(pi, ctx);
    const channel = createDelegateControlChannel(
      path.join(artifactRoot, 'old-scope-delegate.jsonl'),
      'scope-A',
      'foreground',
    );
    const replacement = {
      ...ctx,
      sessionManager: {
        ...ctx.sessionManager,
        getSessionId: () => 'scope-B',
      },
    };
    await handlers.get('session_start')?.({}, replacement);

    resumeRuntimePause(pi, ctx);
    expect(readFileSync(channel.filePath, 'utf8')).toContain('"kind":"resume"');

    channel.close();
    await handlers.get('session_shutdown')?.({}, replacement);
  });

  test('does not enroll a late control channel owned by a replaced session', async () => {
    const { ctx, handlers, pi } = await createAsyncHarness('current');
    requestRuntimePause(pi, ctx);
    const channel = createDelegateControlChannel(
      path.join(artifactRoot, 'stale-delegate.jsonl'),
      'old',
    );
    expect(
      getPauseCoordinator('current').snapshot()?.delegateIds,
    ).not.toContain(channel.participantId);
    expect(() => readFileSync(channel.filePath, 'utf8')).toThrow();

    resumeRuntimePause(pi, ctx);
    channel.close();
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('ignores a late shutdown from a replaced session scope', async () => {
    const { ctx, finish, handlers, sendMessage, tools } =
      await createAsyncHarness('scope-A');
    const replacementContext = {
      ...ctx,
      sessionManager: {
        ...ctx.sessionManager,
        getSessionId: () => 'scope-B',
      },
    };
    await handlers.get('session_start')?.({}, replacementContext);

    await tools.get('delegate')?.execute(
      'call-replacement',
      {
        name: 'Replacement status',
        task: 'inspect independently',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      replacementContext,
    );

    await handlers.get('session_shutdown')?.({}, ctx);

    finish('inspect independently');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await handlers.get('session_shutdown')?.({}, replacementContext);
  });

  test('refreshes terminal live status after owner lifecycle artifact materialization', async () => {
    const { ctx, finish, handlers, sendMessage, tools } =
      await createAsyncHarness();
    const launch = await tools.get('delegate')?.execute(
      'call-lifecycle-status',
      {
        name: 'Lifecycle status',
        task: 'inspect independently',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(launch?.content[0]?.text).toContain('dj-1');

    finish('inspect independently', failedRun());
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    const status = (
      getLiveExtensionSurfaceHub('parent')
        .snapshot()
        .find((surface) => surface.rendererId === 'delegate.status')
        ?.viewModel as
        | {
            statuses?: Array<{
              lifecycle?: {
                reason?: string;
                diagnostic?: string;
                diagnosticArtifact?: { handle?: string };
              };
            }>;
          }
        | undefined
    )?.statuses?.[0];
    expect(status?.lifecycle).toMatchObject({
      reason: 'child-nonzero-exit',
      diagnosticArtifact: { handle: `art_${'a'.repeat(22)}` },
    });
    expect(status?.lifecycle?.diagnostic).toBeUndefined();
    await handlers.get('session_shutdown')?.({}, ctx);
  });

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

    await handlers.get('session_start')?.({}, ctx);
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
      'Continue independent work when useful.',
    );
    expect(launch?.content[0]?.text).toContain(
      'Use delegate_jobs feedback for bounded corrective steering',
    );
    expect(launch?.content[0]?.text).not.toContain('peek to wait');
    expect(launch?.content[0]?.text).toContain('continuation-token');
    expect(sendMessage).not.toHaveBeenCalled();

    finish(successfulRun());
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: 'delegate-job-result',
      content: expect.not.stringContaining('Delegated results: 1 run(s)'),
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
        getLiveExtensionSurfaceHub('parent')
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

    markDashboardFreshUserTurn('parent');
    handlers.get('input')?.({ source: 'extension' }, ctx);
    expect(widget?.render(100)).toEqual([]);
    expect(
      (
        getLiveExtensionSurfaceHub('parent')
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
    expect(foreignPeek?.content[0]?.text).not.toContain('Artifact:');
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
    expect(ownerPeek?.content[0]?.text).toContain('Artifact:');
    const ownerPeekDetails = ownerPeek?.details as {
      job?: {
        runs?: Array<{ artifact?: { handle?: string; size?: number } }>;
      };
    };
    const handle = ownerPeekDetails.job?.runs?.[0]?.artifact?.handle;
    expect(handle).toBeDefined();

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
        jobs?: Array<Record<string, unknown>>;
      }
    ).jobs?.[0];
    expect(ownerListedJob).not.toHaveProperty('runs');
    expect(ownerListedJob).not.toHaveProperty('handoff');
    expect(ownerListedJob).not.toHaveProperty('tasks');
    expect(JSON.stringify(ownerList?.details)).not.toContain(handle);

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
    const { ctx, finish, handlers, sendMessage, tools } =
      await createAsyncHarness();
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
      job: { id: 'dj-3', state: 'success' },
    });
    expect(JSON.stringify(queuedPeek?.details)).not.toContain('third finding');
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
      jobs: [{ id: 'dj-3', state: 'success' }],
    });
    expect(JSON.stringify(queuedCancel?.details)).not.toContain(
      'third finding',
    );

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
    expect(deliveredPeek?.content[0]?.text).toContain('already delivered');
    expect(deliveredPeek?.content[0]?.text).not.toContain('third finding.');
    expect(deliveredPeek?.details).toMatchObject({
      action: 'peek',
      job: { id: 'dj-3', state: 'success' },
      delivery: 'automatic-delivered',
    });
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('rolls back queued delivery state when sendMessage throws', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, finish, handlers, sendMessage, tools } =
      await createAsyncHarness();
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
    const { ctx, finish, handlers, tools } = await createAsyncHarness();
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
    const { ctx, finish, handlers, sendMessage, tools } =
      await createAsyncHarness();
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
    await handlers.get('session_start')?.({}, ctx);
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
    expect(sendMessage).toHaveBeenCalledOnce();

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
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1]?.[0].content).not.toContain(
      'Second finding.',
    );

    const third = successfulRun();
    third.task = 'third';
    third.messages[0] = {
      ...third.messages[0],
      content: [{ type: 'text', text: 'Third finding.' }],
    } as never;
    finishes.get('third')?.(third);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
    expect(sendMessage.mock.calls[2]?.[0].content).not.toContain(
      'Third finding.',
    );
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('isolates same IDs and inherits only current branch workflow entries', async () => {
    const { ctx, pi, finish, hasFinish, handlers, tools } =
      await createAsyncHarness();
    type Path = { entries: unknown[]; leaf: string };
    const paths = new Map<string, Path>([
      // Keep a real parent entry before the first owner marker so the fork
      // exercises an interior target rather than reusing the marker tip.
      [
        'left',
        {
          entries: [{ id: 'left', parentId: null, type: 'message' }],
          leaf: 'left',
        },
      ],
      ['right', { entries: [], leaf: 'right' }],
    ]);
    let activePath = 'left';
    let sequence = 0;
    const manager = ctx.sessionManager as unknown as {
      getLeafId: () => string;
      getBranch: () => unknown[];
      getEntries: () => unknown[];
      getChildren: (parentId: string) => unknown[];
    };
    manager.getLeafId = () => paths.get(activePath)?.leaf ?? activePath;
    manager.getBranch = () => paths.get(activePath)?.entries ?? [];
    manager.getEntries = () =>
      [...paths.values()].flatMap((path) => path.entries);
    manager.getChildren = (parentId) =>
      manager
        .getEntries()
        .filter(
          (entry) => (entry as { parentId?: string }).parentId === parentId,
        );
    const api = pi as unknown as {
      appendEntry: (type: string, data: unknown) => void;
    };
    api.appendEntry = (type, data) => {
      const path = paths.get(activePath);
      if (!path) throw new Error(`Unknown test path ${activePath}`);
      const id = `${activePath}-${++sequence}`;
      path.entries = [
        ...path.entries,
        { id, parentId: path.leaf, type: 'custom', customType: type, data },
      ];
      path.leaf = id;
    };

    handlers.get('session_tree')?.({ oldLeafId: null, newLeafId: 'left' }, ctx);
    const leftReceipt = await tools
      .get('delegate')
      ?.execute(
        'left-call',
        { id: 'impl', task: 'left task', route: 'quick' },
        undefined,
        undefined,
        ctx,
      );
    expect(leftReceipt?.content[0]?.text).toContain('impl@1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish('left task');
    await vi.waitFor(async () => {
      const listed = await tools
        .get('delegate_jobs')
        ?.execute('left-list', { action: 'list' }, undefined, undefined, ctx);
      expect(JSON.stringify(listed)).toContain('impl@1');
    });

    const leftEntries = [...(paths.get('left')?.entries ?? [])];
    const leftLeaf = paths.get('left')?.leaf ?? 'left';
    const ownerMarkerIndex = leftEntries.findIndex(
      (entry) =>
        (entry as { customType?: string }).customType ===
        'delegate-branch-owner:v1',
    );
    expect(ownerMarkerIndex).toBeGreaterThanOrEqual(0);
    const forkEntries = leftEntries.slice(0, ownerMarkerIndex);
    const forkLeaf = (forkEntries.at(-1) as { id?: string } | undefined)?.id;
    if (!forkLeaf) throw new Error('missing mapped ancestor leaf');
    paths.set('right', { entries: forkEntries, leaf: forkLeaf });
    activePath = 'right';
    handlers.get('session_tree')?.(
      { oldLeafId: leftLeaf, newLeafId: forkLeaf },
      ctx,
    );
    const rightReceipt = await tools
      .get('delegate')
      ?.execute(
        'right-call',
        { id: 'impl', task: 'right task', route: 'quick' },
        undefined,
        undefined,
        ctx,
      );
    expect(rightReceipt?.content[0]?.text).toContain('impl@1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish('right task');
    await vi.waitFor(async () => {
      const status = await tools
        .get('delegate_jobs')
        ?.execute(
          'right-status',
          { action: 'status', id: 'impl@1' },
          undefined,
          undefined,
          ctx,
        );
      expect(status?.content[0]?.text).toContain('impl@1 success');
      const rightEntries = paths.get('right')?.entries ?? [];
      expect(JSON.stringify(rightEntries)).not.toContain('left task finding.');
      const rightOwner = rightEntries.find(
        (entry) =>
          (entry as { customType?: string }).customType ===
          'delegate-branch-owner:v1',
      ) as { data?: { ownerBranchId?: string } } | undefined;
      const leftOwner = leftEntries.find(
        (entry) =>
          (entry as { customType?: string }).customType ===
          'delegate-branch-owner:v1',
      ) as { data?: { ownerBranchId?: string } } | undefined;
      expect(rightOwner?.data?.ownerBranchId).toBeDefined();
      expect(rightOwner?.data?.ownerBranchId).not.toBe(
        leftOwner?.data?.ownerBranchId,
      );
      const rightWorkflow = [...rightEntries]
        .reverse()
        .find(
          (entry) =>
            (entry as { customType?: string }).customType ===
            'delegate-workflow:v1',
        ) as
        | {
            data?: {
              state?: {
                attempts?: Array<{
                  identity?: string;
                  ownerBranchId?: string;
                  state?: string;
                }>;
              };
            };
          }
        | undefined;
      expect(rightWorkflow?.data?.state?.attempts?.[0]).toMatchObject({
        identity: 'impl@1',
        state: 'success',
      });
      expect(rightWorkflow?.data?.state?.attempts?.[0]?.ownerBranchId).not.toBe(
        (
          leftEntries.find(
            (entry) =>
              (entry as { customType?: string }).customType ===
              'delegate-workflow:v1',
          ) as
            | {
                data?: {
                  state?: {
                    attempts?: Array<{ ownerBranchId?: string }>;
                  };
                };
              }
            | undefined
        )?.data?.state?.attempts?.[0]?.ownerBranchId,
      );
    });

    paths.set('descendant', { entries: leftEntries, leaf: 'descendant' });
    activePath = 'descendant';
    handlers.get('session_tree')?.(
      { oldLeafId: 'right', newLeafId: 'descendant' },
      ctx,
    );
    const continued = await tools.get('delegate')?.execute(
      'descendant-call',
      {
        id: 'review',
        task: 'descendant task',
        route: 'quick',
        after: ['impl'],
        inputs: [{ node: 'impl', include: ['report'] }],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(continued?.content[0]?.text).toContain('review@1');
    await vi.waitFor(() => expect(hasFinish('descendant task')).toBe(true));
    finish('descendant task');
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('does not append unchanged workflow checkpoints on repeated tip activation', async () => {
    const { ctx, pi, finish, hasFinish, handlers, tools } =
      await createAsyncHarness();
    type Path = { entries: unknown[]; leaf: string };
    const paths = new Map<string, Path>([
      ['root', { entries: [{ id: 'root', type: 'message' }], leaf: 'root' }],
    ]);
    let sequence = 0;
    const activePath = 'root';
    const manager = ctx.sessionManager as unknown as {
      getLeafId: () => string;
      getBranch: () => unknown[];
      getEntries: () => unknown[];
      getChildren: (parentId: string) => unknown[];
    };
    manager.getLeafId = () => paths.get(activePath)?.leaf ?? activePath;
    manager.getBranch = () => paths.get(activePath)?.entries ?? [];
    manager.getEntries = () =>
      [...paths.values()].flatMap((path) => path.entries);
    manager.getChildren = (parentId) =>
      manager
        .getEntries()
        .filter(
          (entry) => (entry as { parentId?: string }).parentId === parentId,
        );
    (
      pi as unknown as { appendEntry: (type: string, data: unknown) => void }
    ).appendEntry = (type, data) => {
      const path = paths.get(activePath);
      if (!path) throw new Error(`Unknown test path ${activePath}`);
      const id = `root-${++sequence}`;
      path.entries = [
        ...path.entries,
        { id, parentId: path.leaf, type: 'custom', customType: type, data },
      ];
      path.leaf = id;
    };

    handlers.get('session_tree')?.({ oldLeafId: null, newLeafId: 'root' }, ctx);
    await tools
      .get('delegate')
      ?.execute(
        'stable-call',
        { id: 'stable', task: 'stable task', route: 'quick' },
        undefined,
        undefined,
        ctx,
      );
    await vi.waitFor(() =>
      expect(
        (paths.get('root')?.entries ?? []).some(
          (entry) =>
            (entry as { customType?: string }).customType ===
            'delegate-branch-owner:v1',
        ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(hasFinish('stable task')).toBe(true));
    finish('stable task');
    await vi.waitFor(() => {
      const entries = paths.get('root')?.entries ?? [];
      expect(JSON.stringify(entries)).toContain('stable@1');
      expect(
        entries.some(
          (entry) =>
            (entry as { customType?: string }).customType ===
            'delegate-workflow:v1',
        ),
      ).toBe(true);
    });

    const before = (paths.get('root')?.entries ?? []).length;
    const tip = paths.get('root')?.leaf;
    if (!tip) throw new Error('missing stable branch tip');
    for (let index = 0; index < 25; index += 1)
      handlers.get('session_tree')?.({ oldLeafId: tip, newLeafId: tip }, ctx);
    expect(paths.get('root')?.entries).toHaveLength(before);
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('admits one persisted queued wake after runtime recreation', async () => {
    const first = await createAsyncHarness('reload-parent');
    await first.tools
      .get('delegate')
      ?.execute(
        'reload-source-call',
        { id: 'reload-source', task: 'reload source task', route: 'quick' },
        undefined,
        undefined,
        first.ctx,
      );
    await vi.waitFor(() =>
      expect(first.hasFinish('reload source task')).toBe(true),
    );
    first.finish('reload source task');
    await vi.waitFor(async () => {
      const status = await first.tools
        .get('delegate_jobs')
        ?.execute(
          'reload-source-status',
          { action: 'status', id: 'reload-source@1' },
          undefined,
          undefined,
          first.ctx,
        );
      expect(status?.content[0]?.text).toContain('success');
    });
    await first.tools.get('delegate_wake')?.execute(
      'reload-wake-call',
      {
        action: 'subscribe',
        id: 'reload-ready',
        condition: { node: 'reload-source@1' },
        payload: ['handoff'],
      },
      undefined,
      undefined,
      first.ctx,
    );
    await vi.waitFor(() => expect(first.sendMessage).toHaveBeenCalledOnce());
    const persistedMessage = first.sendMessage.mock.calls[0]?.[0];
    if (!persistedMessage) throw new Error('missing queued wake message');
    await first.handlers.get('session_shutdown')?.({}, first.ctx);

    const persistedEntries = [
      ...first.entries,
      {
        type: 'custom_message',
        customType: 'delegate-wake-result',
        message: persistedMessage,
      },
    ];
    const restored = await createAsyncHarness('reload-parent', {
      entries: persistedEntries,
      leafId: 'leaf-after-reload',
    });
    expect(restored.sendMessage).not.toHaveBeenCalled();
    const firstContext = restored.handlers.get('context')?.({
      messages: [persistedMessage],
    }) as { messages?: unknown[] } | undefined;
    expect(firstContext?.messages).toEqual([persistedMessage]);
    const repeatedContext = restored.handlers.get('context')?.({
      messages: [persistedMessage],
    }) as { messages?: unknown[] } | undefined;
    expect(repeatedContext?.messages).toEqual([]);
    expect(restored.sendMessage).not.toHaveBeenCalled();
    await restored.handlers.get('session_shutdown')?.({}, restored.ctx);
  });

  test('blocks a persisted pending wake over a running attempt after recreation', async () => {
    const first = await createAsyncHarness('reload-pending');
    await first.tools
      .get('delegate')
      ?.execute(
        'reload-running-call',
        { id: 'reload-running', task: 'reload running task', route: 'quick' },
        undefined,
        undefined,
        first.ctx,
      );
    await vi.waitFor(() =>
      expect(first.hasFinish('reload running task')).toBe(true),
    );
    const pending = await first.tools.get('delegate_wake')?.execute(
      'reload-pending-wake-call',
      {
        action: 'subscribe',
        id: 'reload-pending',
        condition: { node: 'reload-running@1' },
      },
      undefined,
      undefined,
      first.ctx,
    );
    expect(pending?.details).toMatchObject({
      wake: { state: 'pending' },
    });
    // Snapshot the running/pending journal before letting the first runtime
    // finish; shutdown otherwise waits for the deliberately unresolved mock.
    const persistedEntries = [...first.entries];
    first.finish('reload running task');
    await vi.waitFor(() => expect(first.sendMessage).toHaveBeenCalledOnce());
    await first.handlers.get('session_shutdown')?.({}, first.ctx);

    const restored = await createAsyncHarness('reload-pending', {
      entries: persistedEntries,
      leafId: 'leaf-after-pending-reload',
    });
    const status = await restored.tools
      .get('delegate_wake')
      ?.execute(
        'reload-pending-status',
        { action: 'status', id: 'reload-pending' },
        undefined,
        undefined,
        restored.ctx,
      );
    expect(status?.details).toMatchObject({
      wake: {
        state: 'blocked',
        reason: WAKE_RELOAD_ORPHAN_REASON,
      },
    });
    expect(restored.sendMessage).not.toHaveBeenCalled();
    await restored.handlers.get('session_shutdown')?.({}, restored.ctx);
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
        options.onRunUpdate?.(live);
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
      isIdle: () => true,
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
    await handlers.get('session_start')?.({}, ctx);
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
    await handlers.get('session_start')?.({}, ctx);
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
    await handlers.get('session_start')?.({}, ctx);
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
    expect(commands.has('wait')).toBe(false);
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
