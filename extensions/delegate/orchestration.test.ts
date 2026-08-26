import { readFileSync, writeFileSync } from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DelegateConfig } from './config';
import {
  executeSingleDelegate,
  pendingRuns,
  preflightSymbolicBranchPlan,
  preflightSymbolicBranchRequest,
} from './orchestration';
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

const ctx = {
  cwd: '/tmp/project',
  sessionManager: { getSessionId: () => 'test-session' },
} as ExtensionContext;

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
    runId: 'run-test',
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
      sessionId: 'session-test',
      lineageId: 'lineage-test',
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

describe('symbolic branch preflight', () => {
  const plan = (params: Record<string, unknown> = {}) => {
    const task = buildDelegatePlans(
      {
        name: 'Branch consumer',
        task: 'inspect upstream branch',
        route: 'quick',
        ...params,
      },
      ctx,
      config,
      () => null,
    ).tasks[0];
    if (!task) throw new Error('Expected one delegate plan.');
    return task.plan;
  };

  test('projects an implicit read-only shared default to a fresh worktree', () => {
    const candidate = plan();
    expect(candidate).toMatchObject({
      isolation: 'shared',
      isolationExplicit: false,
      writeRequested: false,
    });
    expect(preflightSymbolicBranchPlan(candidate)).toMatchObject({
      isolation: 'worktree',
      isolationExplicit: false,
      writeRequested: false,
    });
  });

  test('accepts an explicit fresh worktree configuration unchanged', () => {
    const candidate = plan({ isolation: 'worktree' });
    expect(preflightSymbolicBranchPlan(candidate)).toBe(candidate);
  });

  test('reports writable default isolation and inherited continuation values truthfully', () => {
    expect(() =>
      preflightSymbolicBranchRequest({
        continuation: false,
        cwd: '/tmp/explicit',
        allowWrites: true,
      }),
    ).toThrow(/requestedIsolation=worktree\(implicit\).*allowWrites=true/);
    expect(() =>
      preflightSymbolicBranchRequest({
        continuation: true,
      }),
    ).toThrow(
      /requestedIsolation=inherited\(continuation\).*allowWrites=inherited\(continuation\)/,
    );
  });

  test('reports every unmet constraint with the effective configuration', () => {
    const candidate = {
      ...plan({ cwd: '/tmp/other', isolation: 'shared' }),
      base: 'head' as const,
      worktreePath: '/tmp/caller-worktree',
    };
    expect(() => preflightSymbolicBranchPlan(candidate)).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /cwd must be omitted.*explicit isolation must be "worktree".*from must be omitted.*worktreePath must be omitted.*mode=fresh.*requested isolation=shared \(explicit\).*effective isolation=unavailable/s,
        ),
      }),
    );
  });
});

describe('buildDelegatePlans', () => {
  test('builds a single fresh task plan', () => {
    const built = buildDelegatePlans(
      { name: 'Test agent', task: ' inspect ', route: 'quick' },
      ctx,
      config,
      () => null,
    );
    expect(built.parallel).toBe(false);
    expect(built.tasks).toHaveLength(1);
    expect(built.tasks[0]?.plan.task).toBe('inspect');
    expect(built.tasks[0]?.plan.context).toBe('fresh');
    expect(built.tasks[0]?.preflight).toBeDefined();
  });

  test('defaults fresh capability and isolation independently', () => {
    const build = (params: Record<string, unknown>) =>
      buildDelegatePlans(
        { name: 'Test agent', task: 'inspect', route: 'quick', ...params },
        ctx,
        config,
        () => null,
      ).tasks[0]?.plan;
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

  test('selects caller worktree paths and rejects unsafe mode combinations', () => {
    expect(
      buildDelegatePlans(
        {
          name: 'Caller audit',
          task: 'inspect',
          route: 'quick',
          worktreePath: '/tmp/caller-worktree',
        },
        ctx,
        config,
        () => null,
      ).tasks[0]?.plan,
    ).toMatchObject({
      isolation: 'worktree',
      worktreePath: '/tmp/caller-worktree',
    });
    expect(() =>
      buildDelegatePlans(
        {
          name: 'Caller audit',
          task: 'inspect',
          route: 'quick',
          isolation: 'shared',
          worktreePath: '/tmp/caller-worktree',
        },
        ctx,
        config,
        () => null,
      ),
    ).toThrow(/worktreePath requires worktree isolation/);
    expect(() =>
      buildDelegatePlans(
        {
          name: 'Caller audit',
          task: 'inspect',
          route: 'quick',
          from: 'head',
          worktreePath: '/tmp/caller-worktree',
        },
        ctx,
        config,
        () => null,
      ),
    ).toThrow(/cannot be combined with from/);
  });

  test('rejects replacing a continuation caller worktree path', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project/caller-worktree',
      allowWrites: false,
      isolation: 'worktree',
      worktreeId: '11111111-1111-1111-1111-111111111111',
    });
    try {
      expect(() =>
        buildDelegatePlans(
          {
            name: 'Caller audit',
            task: 'continue',
            route: 'quick',
            continuation: session.token,
            worktreePath: '/tmp/other-worktree',
          },
          ctx,
          config,
          () => null,
        ),
      ).toThrow(/continuation reuses its original cwd/);
    } finally {
      removeDelegateSession(session);
    }
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
    expect(() =>
      buildDelegatePlans(
        {
          task: 'inspect',
          route: 'quick',
          continuation: '00000000-0000-4000-8000-000000000000',
        },
        ctx,
        config,
        () => null,
      ),
    ).toThrow('Unknown or expired delegate continuation token.');
  });

  test('inherits exact persisted continuation metadata and preserves explicit overrides', () => {
    const persistedRouting: DelegateRouteState = {
      ...routing,
      model: 'historical-model',
      thinking: 'high',
      relativeCost: 9,
    };
    const session = createDelegateSession({
      cwd: '/tmp/project',
      name: 'Original agent',
      routing: persistedRouting,
    });
    try {
      expect(
        buildDelegatePlans(
          { task: 'continue', continuation: session.token },
          ctx,
          config,
          () => null,
        ).tasks[0]?.plan,
      ).toMatchObject({
        name: 'Original agent',
        routing: persistedRouting,
      });
      expect(
        buildDelegatePlans(
          {
            name: 'Override agent',
            task: 'continue differently',
            continuation: session.token,
            route: 'quick',
          },
          ctx,
          config,
          () => null,
        ).tasks[0]?.plan,
      ).toMatchObject({ name: 'Override agent', routing });
    } finally {
      removeDelegateSession(session);
    }
  });

  test('inherits names per item in mixed continuation batches', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      name: 'Continued agent',
      routing,
    });
    try {
      const built = buildDelegatePlans(
        {
          tasks: [
            { task: 'continue', continuation: session.token },
            { name: 'Fresh agent', task: 'inspect fresh', route: 'quick' },
          ],
        },
        ctx,
        config,
        () => null,
      );
      expect(built.tasks.map(({ plan }) => plan.name)).toEqual([
        'Continued agent',
        'Fresh agent',
      ]);
    } finally {
      removeDelegateSession(session);
    }
  });

  test('requires an explicit name for legacy continuation metadata', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      name: 'Legacy original',
      routing,
    });
    const metadataPath = session.filePath.replace(/\.jsonl$/, '.json');
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
        name?: unknown;
      };
      delete metadata.name;
      writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
      expect(() =>
        buildDelegatePlans(
          { task: 'continue', continuation: session.token },
          ctx,
          config,
          () => null,
        ),
      ).toThrow(/legacy metadata.*supply name/);
      expect(
        buildDelegatePlans(
          {
            name: 'Compatibility override',
            task: 'continue explicitly',
            continuation: session.token,
          },
          ctx,
          config,
          () => null,
        ).tasks[0]?.plan.name,
      ).toBe('Compatibility override');
    } finally {
      removeDelegateSession(session);
    }
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

  test('builds parallel plans and attaches matching write warnings', () => {
    const built = buildDelegatePlans(
      {
        tasks: [
          {
            name: 'First writer',
            task: 'inspect',
            route: 'quick',
            allowWrites: true,
            scope: ['/tmp/project/src'],
          },
          {
            name: 'Second writer',
            task: 'implement',
            route: 'quick',
            allowWrites: true,
            scope: ['/tmp/project/src/lib'],
          },
        ],
      },
      ctx,
      config,
      () => '{"messages":[]}',
    );
    const warning =
      'Parallel write tasks 1 and 2 have overlapping declared scopes; their patches may conflict, so review both before applying either.';
    expect(built.parallel).toBe(true);
    expect(built.tasks).toHaveLength(2);
    expect(built.tasks[0]?.plan.writeRequested).toBe(true);
    expect(built.tasks[1]?.plan.writeRequested).toBe(true);
    expect(built.tasks[0]?.plan.warnings).toEqual([warning]);
    expect(built.tasks[1]?.plan.warnings).toEqual([warning]);
    expect(built.tasks[0]?.preflight).toBeDefined();
    expect(built.tasks[1]?.preflight).toBeDefined();
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

  test('rejects unchanged writable/shared values on migrated continuations', () => {
    const requests: Array<{
      allowWrites?: boolean;
      isolation?: 'shared';
    }> = [
      { allowWrites: true },
      { isolation: 'shared' },
      { allowWrites: true, isolation: 'shared' },
    ];
    for (const request of requests) {
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
            {
              name: 'Test agent',
              task: 'continue',
              continuation: session.token,
              ...request,
            },
            ctx,
            config,
            () => null,
          ),
        ).toThrow('Writable delegates require worktree isolation');
      } finally {
        removeDelegateSession(session);
      }
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
      expect(built.tasks[0]?.plan).toMatchObject({
        writeRequested: false,
        allowWritesExplicit: false,
      });
      expect(built.tasks[0]?.preflight).toMatchObject({ allowWrites: false });
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

  test('rejects changing a writable worktree continuation to shared isolation', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      allowWrites: true,
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
    ).toThrow('reuses its original cwd, context, capabilities, and base');
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
      runId: task.runId,
      sessionId: task.session.sessionId,
      lineageId: task.session.lineageId,
      allowWrites: false,
      isolation: 'worktree',
      worktree: {
        id: 'wt-readonly',
        branch: 'pi/audit',
        worktreePath: '/repo/.worktrees/audit',
      },
    });
    expect(
      toolResult.makeDetails('single', run ? [run] : []).runs[0],
    ).toMatchObject({
      runId: task.runId,
      sessionId: task.session.sessionId,
      lineageId: task.session.lineageId,
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

    const result = await executeSingleDelegate(
      runContext(),
      {
        tasks: [
          { name: 'Test agent', task: 'one', route: 'quick' },
          { name: 'Test agent', task: 'two', route: 'quick' },
        ],
      },
      {},
    );
    expect(result.details?.runs).toHaveLength(2);
    expect(result.details?.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lifecycle: expect.objectContaining({ reason: 'setup-failure' }),
        }),
      ]),
    );
    expect(result.content[0]?.text).toContain(
      'Parallel delegate setup failed before launch: prepare failed',
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

    const result = await executeSingleDelegate(
      runContext(),
      { name: 'Test agent', task: 'inspect', route: 'quick' },
      {},
    );
    expect(result.details?.runs?.[0]).toMatchObject({
      state: 'error',
      lifecycle: { reason: 'setup-failure' },
    });
    expect(result.content[0]?.text).toContain(
      'Delegate setup failed before launch: prepare failed',
    );
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
      sessionId: 'session-test',
      exitCode: 1,
      state: 'error',
      errorMessage: expect.stringContaining('spawn failed'),
      warnings: expect.arrayContaining(['discarded wt-1']),
    });
    expect(delegateToolResult).toHaveBeenCalled();
  });
});
