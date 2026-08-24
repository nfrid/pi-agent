import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveDelegateCwd } from './cwd';
import { assertContinuationFields, buildDelegatePlans } from './plans';
import {
  createDelegateSession,
  removeDelegateSession,
  resolveDelegateSession,
  updateDelegateSessionScope,
} from './session';
import { createWorkflowModel } from './workflow-model';

const config = {
  timeoutMs: 10_000,
  maxParallelTasks: 4,
  maxConcurrency: 4,
  modelCatalog: {
    quick: {
      provider: 'test',
      model: 'test-model',
      thinking: 'off' as const,
      relativeCost: 1,
      useFor: 'tests',
      avoid: 'none',
    },
  },
};

const ctx = { cwd: '/parent/project' } as never;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('delegate cwd resolution', () => {
  test.each([
    [undefined, '/parent/project'],
    ['.', '/parent/project'],
    ['./nested/../child', '/parent/project/child'],
    ['../sibling', '/parent/sibling'],
    ['/absolute/child', '/absolute/child'],
  ])('resolves %j against the parent session', (requested, expected) => {
    expect(resolveDelegateCwd(requested, '/parent/project')).toBe(expected);
  });

  test('expands home paths using the effective HOME', () => {
    vi.stubEnv('HOME', '/effective/home');
    expect(resolveDelegateCwd('~', '/parent/project')).toBe('/effective/home');
    expect(resolveDelegateCwd('~/child/../repo', '/parent/project')).toBe(
      '/effective/home/repo',
    );
  });

  test('normalizes single, parallel, and shared cwd inputs before planning', () => {
    const single = buildDelegatePlans(
      { task: 'inspect', name: 'single', cwd: './single', route: 'quick' },
      ctx,
      config,
      () => '{}',
    );
    expect(single.tasks[0]?.plan.requestedCwd).toBe('/parent/project/single');

    const parallel = buildDelegatePlans(
      {
        cwd: '../shared',
        route: 'quick',
        tasks: [
          { name: 'one', task: 'one', cwd: './one' },
          { name: 'two', task: 'two' },
        ],
      },
      ctx,
      config,
      () => '{}',
    );
    expect(parallel.tasks.map(({ plan }) => plan.requestedCwd)).toEqual([
      '/parent/project/one',
      '/parent/shared',
    ]);
  });

  test('continuations retain their persisted cwd without resolving it again', () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'delegate-plans-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const session = createDelegateSession({
      cwd: '../persisted-relative',
      name: 'continued',
      scope: ['old-area'],
      routing: {
        route: 'quick',
        provider: 'test',
        model: 'test-model',
        thinking: 'off',
        relativeCost: 1,
      },
    });
    try {
      const built = buildDelegatePlans(
        {
          task: 'continue',
          continuation: session.token,
          route: 'quick',
        },
        ctx,
        config,
        () => '{}',
      );
      expect(built.tasks[0]?.plan.requestedCwd).toBe('../persisted-relative');
      const replaced = buildDelegatePlans(
        {
          task: 'narrow continuation',
          continuation: session.token,
          route: 'quick',
          scope: ['new-area'],
        },
        ctx,
        config,
        () => '{}',
      );
      expect(replaced.tasks[0]?.plan.scope).toEqual(['new-area']);
      expect(
        updateDelegateSessionScope(session.token, ['new-area'])?.scope,
      ).toEqual(['new-area']);
      expect(resolveDelegateSession(session.token)?.scope).toEqual([
        'new-area',
      ]);
      const inherited = buildDelegatePlans(
        {
          task: 'inherit continuation',
          continuation: session.token,
          route: 'quick',
        },
        ctx,
        config,
        () => '{}',
      );
      expect(inherited.tasks[0]?.plan.scope).toEqual(['new-area']);
    } finally {
      removeDelegateSession(session);
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('delegate continuation parameter preflight', () => {
  test('rejects immutable replacements but permits advisory scope replacement', () => {
    const model = createWorkflowModel();
    model.createFresh('lineage');

    expect(() =>
      assertContinuationFields(
        'lineage',
        { cwd: '/tmp/other-project' },
        'A continuation reuses its original cwd, context, and base; scope may be replaced for this run.',
      ),
    ).toThrow(
      'A continuation reuses its original cwd, context, and base; scope may be replaced for this run.',
    );
    expect(() =>
      assertContinuationFields(
        'lineage',
        { scope: ['new-area'] },
        'scope may be replaced',
      ),
    ).not.toThrow();
    expect(model.snapshot().attempts.map(({ identity }) => identity)).toEqual([
      'lineage@1',
    ]);
    expect(model.continue('lineage').identity).toBe('lineage@2');
  });
});
