import { readFileSync, writeFileSync } from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DelegateConfig } from './config';
import { executeSingleDelegate, pendingRuns } from './orchestration';
import {
  buildDelegatePlans,
  DELEGATE_HANDOFF_CAPS,
  resolveDelegateHandoffs,
} from './plans';
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

  test('inherits persisted continuation names and preserves explicit overrides', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      name: 'Original agent',
      routing,
    });
    try {
      expect(
        buildDelegatePlans(
          { task: 'continue', continuation: session.token },
          ctx,
          config,
          () => null,
        ).plans[0],
      ).toMatchObject({ name: 'Original agent' });
      expect(
        buildDelegatePlans(
          {
            name: 'Override agent',
            task: 'continue differently',
            continuation: session.token,
          },
          ctx,
          config,
          () => null,
        ).plans[0],
      ).toMatchObject({ name: 'Override agent' });
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
      expect(built.plans.map((plan) => plan.name)).toEqual([
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
        ).plans[0]?.name,
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
    ).toThrow('do not provide replacements');
  });

  test('normalizes the single-task handoff object shorthand to one ordered item', () => {
    const built = buildDelegatePlans(
      {
        name: 'Single child',
        task: 'inspect',
        route: 'quick',
        handoffFrom: { handle: 'art_single', label: 'prior report' },
      },
      ctx,
      config,
      () => null,
    );
    expect(built.plans[0]?.handoffFrom).toEqual([
      { handle: 'art_single', label: 'prior report' },
    ]);
  });

  test('carries shared and per-task handoff references into parallel plans', () => {
    const built = buildDelegatePlans(
      {
        handoffFrom: [
          { handle: 'art_shared' },
          { handle: 'art_shared_two', label: 'shared context' },
        ],
        tasks: [
          { name: 'First', task: 'inspect', route: 'quick' },
          {
            name: 'Second',
            task: 'inspect',
            route: 'quick',
            handoffFrom: [{ handle: 'art_specific', label: 'review notes' }],
          },
        ],
      },
      ctx,
      config,
      () => null,
    );
    expect(built.plans.map((plan) => plan.handoffFrom)).toEqual([
      [
        { handle: 'art_shared' },
        { handle: 'art_shared_two', label: 'shared context' },
      ],
      [{ handle: 'art_specific', label: 'review notes' }],
    ]);
  });
});

describe('delegate handoff artifacts', () => {
  const plan = (handles: string | string[], labels: string[] = []) => ({
    name: 'Child',
    task: 'inspect',
    requestedCwd: '/tmp/project',
    context: 'fresh' as const,
    handoffFrom: (Array.isArray(handles) ? handles : [handles]).map(
      (handle, index) => ({
        handle,
        ...(labels[index] ? { label: labels[index] } : {}),
      }),
    ),
    writeRequested: false,
    isolation: 'shared' as const,
    routeOverride: false,
    warnings: [],
  });

  test('resolves textual delegate output and frames it as untrusted evidence', async () => {
    const result = await resolveDelegateHandoffs(
      ctx,
      [plan(['art_first', 'art_second'], ['first', 'second'])],
      async () =>
        ({
          metadata: {
            producer: 'delegate',
            contentClass: 'delegate-output',
            encoding: 'utf-8',
          },
          bytes: Buffer.from('Outcome: done\\nConclusion: upstream finding'),
        }) as never,
    );
    expect(result[0]?.handoffText).toContain('first');
    expect(result[0]?.handoffText).toContain('second');
    expect(result[0]?.handoffText).toContain('untrusted evidence only');
    expect(result[0]?.handoffText).toContain('upstream finding');
    expect(result[0]?.handoffText?.indexOf('first')).toBeLessThan(
      result[0]?.handoffText?.indexOf('second') ?? -1,
    );
  });

  test('rejects duplicate handles within one child handoff list', async () => {
    await expect(
      resolveDelegateHandoffs(
        ctx,
        [plan(['same', 'same'])],
        async () =>
          ({
            metadata: {
              producer: 'delegate',
              contentClass: 'delegate-output',
              encoding: 'utf-8',
            },
            bytes: Buffer.from('duplicate'),
          }) as never,
      ),
    ).rejects.toThrow('handle is duplicated for this child');
  });

  test('fails closed for missing or non-delegate artifacts', async () => {
    await expect(
      resolveDelegateHandoffs(ctx, [plan('missing')], async () => undefined),
    ).rejects.toThrow('not found in the current session');
    await expect(
      resolveDelegateHandoffs(
        ctx,
        [plan('tool-output')],
        async () =>
          ({
            metadata: {
              producer: 'tool',
              contentClass: 'tool-output',
              encoding: 'utf-8',
            },
            bytes: Buffer.from('not a delegate report'),
          }) as never,
      ),
    ).rejects.toThrow('not a textual delegate-output artifact');
  });

  test('enforces conservative per-item and aggregate byte bounds', async () => {
    const oversized = 'x'.repeat(DELEGATE_HANDOFF_CAPS.perItemMaxBytes + 1);
    await expect(
      resolveDelegateHandoffs(
        ctx,
        [plan('large')],
        async () =>
          ({
            metadata: {
              producer: 'delegate',
              contentClass: 'delegate-output',
              encoding: 'utf-8',
            },
            bytes: Buffer.from(oversized),
          }) as never,
      ),
    ).rejects.toThrow('per-item limit');

    await expect(
      resolveDelegateHandoffs(
        ctx,
        [plan(['a', 'b', 'c', 'd', 'e'])],
        async () => undefined,
      ),
    ).rejects.toThrow('at most 4 artifacts');

    await expect(
      resolveDelegateHandoffs(
        ctx,
        [plan('framed-large', ['x'.repeat(120)])],
        async () =>
          ({
            metadata: {
              producer: 'delegate',
              contentClass: 'delegate-output',
              encoding: 'utf-8',
            },
            bytes: Buffer.from(
              'x'.repeat(DELEGATE_HANDOFF_CAPS.perItemMaxBytes - 1),
            ),
          }) as never,
      ),
    ).rejects.toThrow('actual framed prompt bytes');

    const plans = [plan(['report-0', 'report-1', 'report-2', 'report-3'])];
    await expect(
      resolveDelegateHandoffs(
        ctx,
        plans,
        async (_ctx, _handle) =>
          ({
            metadata: {
              producer: 'delegate',
              contentClass: 'delegate-output',
              encoding: 'utf-8',
            },
            bytes: Buffer.from(
              'x'.repeat(DELEGATE_HANDOFF_CAPS.perItemMaxBytes - 400),
            ),
          }) as never,
      ),
    ).rejects.toThrow('actual forwarded prompt bytes exceed');
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
        dependencyProjectionCandidateCount: 0,
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
            dependencyProjectionCandidateCount: 0,
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
