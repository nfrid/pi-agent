import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  createDelegateSession,
  removeDelegateSession,
  resolveDelegateSession,
} from './session';
import {
  type DelegateTaskPlan,
  preflightDelegateContinuation,
  prepareDelegateTask,
  rollbackPreparedDelegateTasks,
} from './task-lifecycle';
import { repository } from './test/worktree-fixture';
import type { DelegateRouteState } from './types';

const originalRoute: DelegateRouteState = {
  route: 'original',
  provider: 'openai-codex',
  model: 'original-model',
  thinking: 'low',
  relativeCost: 1,
};

function plan(overrides: Partial<DelegateTaskPlan> = {}): DelegateTaskPlan {
  return {
    name: 'Inspection agent',
    task: 'inspect',
    requestedCwd: repository,
    context: 'fresh',
    writeRequested: false,
    routeOverride: false,
    warnings: [],
    ...overrides,
  };
}

describe('delegate task lifecycle', () => {
  test('rolls back fresh sessions and resumed route overrides', async () => {
    const resumed = createDelegateSession({
      cwd: repository,
      routing: originalRoute,
    });
    const fresh = await prepareDelegateTask(plan());
    const override: DelegateRouteState = {
      ...originalRoute,
      route: 'override',
      model: 'override-model',
    };
    const continued = await prepareDelegateTask(
      plan({
        context: 'continuation',
        resumed,
        routeOverride: true,
        routing: override,
      }),
    );

    try {
      expect(resolveDelegateSession(resumed.token)?.routing).toEqual(override);
      expect(existsSync(fresh.session.filePath)).toBe(true);
      await expect(
        rollbackPreparedDelegateTasks([fresh, continued]),
      ).resolves.toEqual([]);
      expect(resolveDelegateSession(fresh.session.token)).toBeNull();
      expect(resolveDelegateSession(resumed.token)?.routing).toEqual(
        originalRoute,
      );
    } finally {
      removeDelegateSession(resumed);
      removeDelegateSession(fresh.session);
    }
  });

  test('restores a writable continuation in its persisted worktree', async () => {
    const prepared = await prepareDelegateTask(
      plan({ scope: ['src'], writeRequested: true, base: 'head' }),
    );
    expect(prepared.worktree).toBeDefined();
    expect(prepared.session.allowWrites).toBe(true);
    expect(prepared.cwd).toBe(prepared.worktree?.record.worktreePath);

    try {
      // A continuation must land in the same worktree; otherwise the child
      // would resume against a checkout that no longer holds its work.
      const restored = preflightDelegateContinuation(
        plan({
          requestedCwd: '/wrong',
          context: 'continuation',
          scope: ['wrong'],
          // Omission inherits the session capability rather than making a
          // writable continuation read-only.
          writeRequested: true,
          allowWritesExplicit: false,
          resumed: prepared.session,
        }),
      );
      expect(restored).toMatchObject({
        cwd: prepared.cwd,
        scope: ['src'],
        allowWrites: true,
      });
      expect(restored.worktree?.record.sessionToken).toBe(
        prepared.session.token,
      );
      expect(restored.worktree?.record.branch).toBe(
        prepared.worktree?.record.branch,
      );
    } finally {
      await rollbackPreparedDelegateTasks([prepared]);
    }
  });
});
