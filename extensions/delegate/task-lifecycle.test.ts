import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
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
import { createRun } from './types';
import { removeWorktree } from './worktree';
import { finalizeWorktreeRun } from './worktree-lifecycle';

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
    isolation: 'shared',
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

  test('fails closed when requested worktree setup is unavailable', async () => {
    await expect(
      prepareDelegateTask(
        plan({
          requestedCwd: '/tmp/not-a-delegate-repository',
          isolation: 'worktree',
        }),
      ),
    ).rejects.toThrow(/Worktree unavailable/);
  });

  test('prepares an isolated read-only task in a worktree', async () => {
    const prepared = await prepareDelegateTask(
      plan({ isolation: 'worktree', base: 'head' }),
    );
    try {
      expect(prepared.allowWrites).toBe(false);
      expect(prepared.isolation).toBe('worktree');
      expect(prepared.worktree).toBeDefined();
      expect(prepared.cwd).toBe(prepared.worktree?.record.worktreePath);
      expect(prepared.session).toMatchObject({
        isolation: 'worktree',
        allowWrites: false,
        worktreeId: prepared.worktree?.record.id,
      });
    } finally {
      await rollbackPreparedDelegateTasks([prepared]);
    }
  });

  test('rejects snapshot refresh for a writable continuation', async () => {
    const writable = await prepareDelegateTask(
      plan({ isolation: 'worktree', writeRequested: true }),
    );
    try {
      expect(() =>
        preflightDelegateContinuation(
          plan({
            context: 'continuation',
            writeRequested: true,
            isolation: 'worktree',
            refresh: 'wip',
            resumed: writable.session,
          }),
        ),
      ).toThrow(/read-only worktree continuation/);
    } finally {
      await rollbackPreparedDelegateTasks([writable]);
    }
  });

  test('rehydrates a retired read-only snapshot and refreshes from WIP or HEAD', async () => {
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'original WIP\n');
    const initial = await prepareDelegateTask(
      plan({ isolation: 'worktree', base: 'wip' }),
    );
    if (!initial.worktree) throw new Error('missing initial worktree');
    const completed = createRun('review', undefined, { allowWrites: false });
    completed.state = 'success';
    completed.exitCode = 0;
    await finalizeWorktreeRun(completed, initial.worktree, 'review');
    expect(existsSync(initial.worktree.record.worktreePath)).toBe(false);
    writeFileSync(path.join(repository, '.env'), 'SECRET=new-parent-value\n');

    const same = await prepareDelegateTask(
      plan({
        context: 'continuation',
        writeRequested: false,
        isolation: 'worktree',
        resumed: initial.session,
      }),
    );
    expect(readFileSync(path.join(same.cwd, 'src', 'value.txt'), 'utf8')).toBe(
      'original WIP\n',
    );
    expect(readFileSync(path.join(same.cwd, '.env'), 'utf8')).toBe(
      'SECRET=local\n',
    );
    writeFileSync(
      path.join(repository, 'src', 'value.txt'),
      'new parent WIP\n',
    );
    const refreshed = await prepareDelegateTask(
      plan({
        context: 'continuation',
        writeRequested: false,
        isolation: 'worktree',
        refresh: 'wip',
        resumed: same.session,
      }),
    );
    expect(
      readFileSync(path.join(refreshed.cwd, 'src', 'value.txt'), 'utf8'),
    ).toBe('new parent WIP\n');
    expect(refreshed.snapshotNotice).toMatch(
      /prior source observations may be stale/,
    );
    const fromHead = await prepareDelegateTask(
      plan({
        context: 'continuation',
        writeRequested: false,
        isolation: 'worktree',
        refresh: 'head',
        resumed: refreshed.session,
      }),
    );
    expect(
      readFileSync(path.join(fromHead.cwd, 'src', 'value.txt'), 'utf8'),
    ).toBe('one\n');

    await removeWorktree(fromHead.worktree?.record.id ?? '', {
      deleteBranch: true,
    });
    removeDelegateSession(fromHead.session);
  });

  test('restores a writable continuation in its persisted worktree', async () => {
    const prepared = await prepareDelegateTask(
      plan({
        scope: ['src'],
        writeRequested: true,
        isolation: 'worktree',
        base: 'head',
      }),
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
