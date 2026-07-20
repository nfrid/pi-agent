import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DelegateConfig } from './config';
import type { PreparedIsolation } from './isolation';
import { executeSingleDelegate } from './orchestration';
import { buildDelegatePlans } from './plans';
import type { PreparedDelegateTask } from './task-lifecycle';
import * as taskLifecycle from './task-lifecycle';
import * as toolResult from './tool-result';
import type { DelegateRouteState } from './types';

const config: DelegateConfig = {
  timeoutMs: 60_000,
  maxParallelTasks: 2,
  maxConcurrency: 2,
  maxRelativeCost: 3,
  provider: 'openai-codex',
  modelCatalog: {
    quick: {
      model: 'gpt-test',
      thinking: 'low',
      relativeCost: 1,
      relativeIntelligence: 1,
    },
  },
};

const routing: DelegateRouteState = {
  route: 'quick',
  provider: 'openai-codex',
  model: 'gpt-test',
  thinking: 'low',
  relativeCost: 1,
  relativeIntelligence: 1,
};

const ctx = { cwd: '/tmp/project' } as ExtensionContext;

afterEach(() => {
  vi.restoreAllMocks();
});

function runContext() {
  return {
    pi: {} as ExtensionAPI,
    ctx,
    config,
    getSnapshot: () => null,
  };
}

function prepared(
  overrides: Partial<PreparedDelegateTask> = {},
): PreparedDelegateTask {
  return {
    plan: {
      task: 'inspect',
      requestedCwd: '/tmp/project',
      context: 'fresh',
      writeRequested: false,
      routeOverride: false,
      warnings: [],
      routing,
    },
    session: {
      token: 'tok',
      filePath: '/tmp/delegate.jsonl',
      cwd: '/tmp/project',
    },
    cwd: '/tmp/project',
    allowWrites: false,
    warnings: [],
    ...overrides,
  };
}

describe('buildDelegatePlans', () => {
  test('builds a single fresh task plan', () => {
    const built = buildDelegatePlans(
      { task: ' inspect ', route: 'quick' },
      ctx,
      config,
      () => null,
    );
    expect(built.parallel).toBe(false);
    expect(built.plans).toHaveLength(1);
    expect(built.plans[0]?.task).toBe('inspect');
    expect(built.plans[0]?.context).toBe('fresh');
    expect(built.preflights).toHaveLength(1);
  });

  test('requires a branch snapshot for branch context', () => {
    expect(() =>
      buildDelegatePlans(
        { task: 'inspect', route: 'quick', context: 'branch' },
        ctx,
        config,
        () => null,
      ),
    ).toThrow('failed to snapshot current session branch.');
  });

  test('builds parallel plans and attaches write warnings', () => {
    const built = buildDelegatePlans(
      {
        tasks: [
          { task: 'inspect', route: 'quick' },
          {
            task: 'implement',
            route: 'quick',
            allowWrites: true,
            scope: ['/tmp/project/src'],
          },
        ],
      },
      ctx,
      config,
      () => '{"messages":[]}',
    );
    expect(built.parallel).toBe(true);
    expect(built.plans).toHaveLength(2);
    expect(built.plans[1]?.writeRequested).toBe(true);
    expect(built.preflights).toHaveLength(2);
  });

  test('rejects an empty parallel task list', () => {
    expect(() =>
      buildDelegatePlans({ tasks: [{ task: '   ' }] }, ctx, config, () => null),
    ).toThrow('Parallel delegation requires a non-empty task.');
  });

  test('rejects too many parallel tasks', () => {
    expect(() =>
      buildDelegatePlans(
        {
          tasks: [
            { task: 'one', route: 'quick' },
            { task: 'two', route: 'quick' },
            { task: 'three', route: 'quick' },
          ],
        },
        ctx,
        config,
        () => null,
      ),
    ).toThrow('Too many delegated tasks (3). Maximum is 2.');
  });

  test('rejects shared continuation on parallel requests', () => {
    expect(() =>
      buildDelegatePlans(
        {
          tasks: [{ task: 'inspect', route: 'quick' }],
          continuation: 'token',
        },
        ctx,
        config,
        () => null,
      ),
    ).toThrow(
      'For parallel delegation, set continuation on each task rather than as a shared default.',
    );
  });

  test('rejects continuation field replacements on single tasks', () => {
    expect(() =>
      buildDelegatePlans(
        {
          task: 'inspect',
          continuation: 'token',
          cwd: '/other',
        },
        ctx,
        config,
        () => null,
      ),
    ).toThrow('do not provide replacements');
  });
});

describe('executeSingleDelegate lifecycle', () => {
  test('rolls back prepared tasks when parallel setup fails', async () => {
    const rollback = vi
      .spyOn(taskLifecycle, 'rollbackPreparedDelegateTasks')
      .mockResolvedValue(['cleanup warn']);
    vi.spyOn(taskLifecycle, 'prepareDelegateTask')
      .mockResolvedValueOnce(prepared())
      .mockRejectedValueOnce(new Error('prepare failed'));

    await expect(
      executeSingleDelegate(
        runContext(),
        {
          tasks: [
            { task: 'one', route: 'quick' },
            { task: 'two', route: 'quick' },
          ],
        },
        {},
      ),
    ).rejects.toThrow(
      'Parallel delegate setup failed before launch: prepare failed Cleanup warnings: cleanup warn',
    );
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  test('rolls back prepared tasks when single setup fails', async () => {
    vi.spyOn(taskLifecycle, 'rollbackPreparedDelegateTasks').mockResolvedValue(
      [],
    );
    vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockRejectedValue(
      new Error('prepare failed'),
    );

    await expect(
      executeSingleDelegate(
        runContext(),
        { task: 'inspect', route: 'quick' },
        {},
      ),
    ).rejects.toThrow('Delegate setup failed before launch: prepare failed');
  });

  test('returns a failed lifecycle run when launch fails before isolation starts', async () => {
    vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockResolvedValue(
      prepared({
        isolation: {
          record: {
            id: 'iso-1',
            backend: 'macos-sandbox-exec',
            repositoryRoot: '/repo',
            worktreePath: '/repo/.pi/worktrees/iso-1',
            workingDirectory: '.',
            baseHead: 'abc',
            dependencyMode: 'link',
            status: 'prepared',
          },
          profilePath: '/tmp/profile.sb',
          env: {},
        } as PreparedIsolation,
      }),
    );
    vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockRejectedValue(
      new Error('spawn failed'),
    );
    vi.spyOn(taskLifecycle, 'cleanupFreshPreparedTask').mockResolvedValue({
      warnings: ['discarded iso-1'],
    });
    const delegateToolResult = vi
      .spyOn(toolResult, 'delegateToolResult')
      .mockImplementation(async (_pi, _ctx, mode, runs) => ({
        content: [{ type: 'text' as const, text: 'handoff' }],
        details: { mode, runs },
      }));

    const result = await executeSingleDelegate(
      runContext(),
      { task: 'inspect', route: 'quick' },
      {},
    );

    expect(result.details?.runs?.[0]).toMatchObject({
      exitCode: 1,
      state: 'error',
      errorMessage: expect.stringContaining('spawn failed'),
      warnings: expect.arrayContaining(['discarded iso-1']),
    });
    expect(delegateToolResult).toHaveBeenCalled();
  });
});
