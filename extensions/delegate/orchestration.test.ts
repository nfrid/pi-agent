import { readFileSync, writeFileSync } from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DelegateConfig } from './config';
import { executeSingleDelegate, pendingRuns } from './orchestration';
import { buildDelegatePlans } from './plans';
import { createDelegateSession, removeDelegateSession } from './session';
import type { PreparedDelegateTask } from './task-lifecycle';
import * as taskLifecycle from './task-lifecycle';
import * as toolResult from './tool-result';
import type { DelegateRouteState } from './types';
import type { PreparedWorktree } from './worktree';

const config: DelegateConfig = {
  timeoutMs: 60_000,
  maxParallelTasks: 2,
  maxConcurrency: 2,
  provider: 'openai-codex',
  modelCatalog: {
    quick: {
      model: 'gpt-test',
      thinking: 'low',
      relativeCost: 1,
      useFor: 'cheap checks',
      avoid: 'judgement calls',
    },
  },
};

const routing: DelegateRouteState = {
  route: 'quick',
  provider: 'openai-codex',
  model: 'gpt-test',
  thinking: 'low',
  relativeCost: 1,
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
      name: 'Test agent',
      task: 'inspect',
      requestedCwd: '/tmp/project',
      context: 'fresh',
      writeRequested: false,
      isolation: 'shared',
      routeOverride: false,
      warnings: [],
      routing,
    },
    session: {
      token: 'tok',
      filePath: '/tmp/delegate.jsonl',
      cwd: '/tmp/project',
      isolation: 'shared',
    },
    cwd: '/tmp/project',
    allowWrites: false,
    warnings: [],
    ...overrides,
    isolation: overrides.isolation ?? 'shared',
  };
}

describe('buildDelegatePlans', () => {
  test('builds a single fresh task plan', () => {
    const built = buildDelegatePlans(
      { name: 'Test agent', task: ' inspect ', route: 'quick' },
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

  test('defaults fresh capability and isolation independently', () => {
    const build = (params: Record<string, unknown>) =>
      buildDelegatePlans(
        { name: 'Test agent', task: 'inspect', route: 'quick', ...params },
        ctx,
        config,
        () => null,
      ).plans[0];
    expect(build({})).toMatchObject({
      writeRequested: false,
      isolation: 'shared',
    });
    expect(build({ allowWrites: true })).toMatchObject({
      writeRequested: true,
      isolation: 'worktree',
    });
    expect(build({ isolation: 'worktree' })).toMatchObject({
      writeRequested: false,
      isolation: 'worktree',
    });
    expect(build({ allowWrites: false, isolation: 'shared' })).toMatchObject({
      writeRequested: false,
      isolation: 'shared',
    });
  });

  test('rejects writable shared delegates and base selection on shared delegates', () => {
    for (const params of [
      { allowWrites: true, isolation: 'shared' as const },
      { from: 'head' as const },
    ])
      expect(() =>
        buildDelegatePlans(
          { name: 'Test agent', task: 'inspect', route: 'quick', ...params },
          ctx,
          config,
          () => null,
        ),
      ).toThrow(
        /(?:Writable delegates require worktree|from requires worktree)/,
      );
  });

  test('requires a name for every subagent', () => {
    expect(() =>
      buildDelegatePlans(
        { task: 'inspect', route: 'quick' },
        ctx,
        config,
        () => null,
      ),
    ).toThrow('Delegate name is required with task.');
    expect(() =>
      buildDelegatePlans(
        {
          tasks: [{ task: 'inspect', route: 'quick' }],
        } as never,
        ctx,
        config,
        () => null,
      ),
    ).toThrow('Every delegated task requires a subagent name.');
  });

  test('requires a branch snapshot for branch context', () => {
    expect(() =>
      buildDelegatePlans(
        {
          name: 'Test agent',
          task: 'inspect',
          route: 'quick',
          context: 'branch',
        },
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
          { name: 'Test agent', task: 'inspect', route: 'quick' },
          {
            name: 'Test agent',
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
      buildDelegatePlans(
        { tasks: [{ name: 'Test agent', task: '   ' }] },
        ctx,
        config,
        () => null,
      ),
    ).toThrow('Parallel delegation requires a non-empty task.');
  });

  test('rejects too many parallel tasks', () => {
    expect(() =>
      buildDelegatePlans(
        {
          tasks: [
            { name: 'Test agent', task: 'one', route: 'quick' },
            { name: 'Test agent', task: 'two', route: 'quick' },
            { name: 'Test agent', task: 'three', route: 'quick' },
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
          tasks: [{ name: 'Test agent', task: 'inspect', route: 'quick' }],
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

  test('rejects a migrated writable shared continuation', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      allowWrites: true,
      routing,
    });
    try {
      const metadataPath = session.filePath.replace(/\.jsonl$/, '.json');
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
        isolation?: unknown;
      };
      delete metadata.isolation;
      writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
      expect(() =>
        buildDelegatePlans(
          { name: 'Test agent', task: 'continue', continuation: session.token },
          ctx,
          config,
          () => null,
        ),
      ).toThrow('Writable delegates require worktree isolation');
    } finally {
      removeDelegateSession(session);
    }
  });

  test('inherits a read-only continuation capability when allowWrites is omitted', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      allowWrites: false,
      routing,
    });
    try {
      const built = buildDelegatePlans(
        { name: 'Test agent', task: 'continue', continuation: session.token },
        ctx,
        config,
        () => null,
      );
      expect(built.plans[0]).toMatchObject({
        writeRequested: false,
        allowWritesExplicit: false,
      });
      expect(built.preflights[0]).toMatchObject({ allowWrites: false });
    } finally {
      removeDelegateSession(session);
    }
  });

  test('rejects elevating a read-only continuation', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      allowWrites: false,
      routing,
    });
    try {
      expect(() =>
        buildDelegatePlans(
          {
            name: 'Test agent',
            task: 'continue',
            continuation: session.token,
            allowWrites: true,
          },
          ctx,
          config,
          () => null,
        ),
      ).toThrow('cannot change allowWrites from read-only to writable');
    } finally {
      removeDelegateSession(session);
    }
  });

  test('rejects demoting a writable continuation', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      allowWrites: true,
      routing,
    });
    try {
      expect(() =>
        buildDelegatePlans(
          {
            name: 'Test agent',
            task: 'continue',
            continuation: session.token,
            allowWrites: false,
          },
          ctx,
          config,
          () => null,
        ),
      ).toThrow('cannot change allowWrites from writable to read-only');
    } finally {
      removeDelegateSession(session);
    }
  });

  test('inherits immutable worktree isolation on continuation', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      allowWrites: false,
      isolation: 'worktree',
      worktreeId: 'missing-worktree',
      routing,
    });
    try {
      expect(() =>
        buildDelegatePlans(
          {
            name: 'Test agent',
            task: 'continue',
            continuation: session.token,
            isolation: 'shared',
          },
          ctx,
          config,
          () => null,
        ),
      ).toThrow('cannot change isolation from worktree to shared');
    } finally {
      removeDelegateSession(session);
    }
  });

  test('rejects continuation field replacements on single tasks', () => {
    expect(() =>
      buildDelegatePlans(
        {
          name: 'Test agent',
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

describe('pending delegate runs', () => {
  test('exposes prepared worktree identity before an isolated child launches', () => {
    const worktree: PreparedWorktree = {
      record: {
        version: 1,
        id: 'wt-readonly',
        repositoryRoot: '/repo',
        worktreePath: '/repo/.worktrees/audit',
        workingDirectory: '.',
        branch: 'pi/audit',
        baseHead: 'abc12345',
        base: 'head',
        carriedWip: false,
        dependencyLinks: [],
        carriedFiles: [],
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      env: {},
    };
    const task = prepared({
      isolation: 'worktree',
      worktree,
    });
    const run = pendingRuns({ mode: 'single', tasks: [task] })[0];
    expect(run).toMatchObject({
      allowWrites: false,
      isolation: 'worktree',
      worktree: {
        id: 'wt-readonly',
        branch: 'pi/audit',
        worktreePath: '/repo/.worktrees/audit',
      },
    });
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
            { name: 'Test agent', task: 'one', route: 'quick' },
            { name: 'Test agent', task: 'two', route: 'quick' },
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
        { name: 'Test agent', task: 'inspect', route: 'quick' },
        {},
      ),
    ).rejects.toThrow('Delegate setup failed before launch: prepare failed');
  });

  test('returns a failed lifecycle run when launch fails before the child starts', async () => {
    vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockResolvedValue(
      prepared({
        worktree: {
          record: {
            version: 1,
            id: 'wt-1',
            repositoryRoot: '/repo',
            worktreePath: '/repo/.worktrees/wt-1',
            workingDirectory: '.',
            branch: 'pi/inspect-a1b2',
            baseHead: 'abc',
            base: 'wip',
            carriedWip: true,
            dependencyLinks: [],
            carriedFiles: [],
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          env: {},
        } as PreparedWorktree,
      }),
    );
    vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockRejectedValue(
      new Error('spawn failed'),
    );
    vi.spyOn(taskLifecycle, 'cleanupFreshPreparedTask').mockResolvedValue({
      warnings: ['discarded wt-1'],
    });
    const delegateToolResult = vi
      .spyOn(toolResult, 'delegateToolResult')
      .mockImplementation(async (_pi, _ctx, mode, runs) => ({
        content: [{ type: 'text' as const, text: 'handoff' }],
        details: { mode, runs },
      }));

    const result = await executeSingleDelegate(
      runContext(),
      { name: 'Test agent', task: 'inspect', route: 'quick' },
      {},
    );

    expect(result.details?.runs?.[0]).toMatchObject({
      exitCode: 1,
      state: 'error',
      errorMessage: expect.stringContaining('spawn failed'),
      warnings: expect.arrayContaining(['discarded wt-1']),
    });
    expect(delegateToolResult).toHaveBeenCalled();
  });
});
