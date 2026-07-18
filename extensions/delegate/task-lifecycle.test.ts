import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { sandboxBackendAvailable } from './isolation';
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
import { repository } from './test/isolation-fixture';
import type { DelegateRouteState } from './types';

const originalRoute: DelegateRouteState = {
  route: 'original',
  provider: 'openai-codex',
  model: 'original-model',
  thinking: 'low',
  relativeCost: 1,
  relativeIntelligence: 1,
};

function plan(overrides: Partial<DelegateTaskPlan> = {}): DelegateTaskPlan {
  return {
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

  test.skipIf(!sandboxBackendAvailable())(
    'restores persisted isolation cwd, scope, and session ownership',
    async () => {
      const prepared = await prepareDelegateTask(
        plan({
          scope: ['src'],
          writeRequested: true,
          dependencyMode: 'isolated',
        }),
      );
      expect(prepared.isolation).toBeDefined();

      try {
        const restored = preflightDelegateContinuation(
          plan({
            requestedCwd: '/wrong',
            context: 'continuation',
            scope: ['wrong'],
            writeRequested: true,
            resumed: prepared.session,
          }),
        );
        expect(restored).toMatchObject({
          cwd: prepared.cwd,
          scope: ['src'],
          allowWrites: true,
        });
        expect(restored.isolation?.record.sessionToken).toBe(
          prepared.session.token,
        );
      } finally {
        await rollbackPreparedDelegateTasks([prepared]);
      }
    },
  );
});
