import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  attachIsolationSession,
  captureIsolationPatch,
  discardIsolation,
  isolationSpawn,
  markIsolationRunning,
  prepareWritableIsolation,
  sandboxBackendAvailable,
} from './isolation';
import { runDelegate } from './runner';
import { agentDir, git, repository, root } from './test/isolation-fixture';
import { getRunState } from './types';

describe('isolation lifecycle and worktree', () => {
  test.skipIf(!sandboxBackendAvailable())(
    'refuses to discard an active child worktree',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-running.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      await markIsolationRunning(prepared.record.id);
      await expect(discardIsolation(prepared.record.id)).rejects.toThrow(
        /child is running/,
      );
      await captureIsolationPatch(prepared.record.id, { outcome: 'error' });
      await discardIsolation(prepared.record.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'recovers and discards a stale running worktree owner',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-stale-owner.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      await markIsolationRunning(prepared.record.id);
      const recordPath = path.join(
        agentDir,
        'state',
        'delegate-worktrees',
        'v1',
        prepared.record.id,
        'record.json',
      );
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
        runOwner: { pid: number; identity: string; startedAt: string };
      };
      record.runOwner = {
        pid: 999_999,
        identity: 'definitely-not-live',
        startedAt: new Date(0).toISOString(),
      };
      writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
      await discardIsolation(prepared.record.id);
      expect(existsSync(prepared.record.worktreePath)).toBe(false);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'isolates a nested workspace cwd at the containing repository root',
    async () => {
      const nested = path.join(repository, 'packages', 'app');
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(nested, 'value.txt'), 'nested\n');
      git(repository, ['add', '.']);
      git(repository, ['commit', '-qm', 'nested workspace fixture']);
      const result = await prepareWritableIsolation({
        cwd: nested,
        scopes: ['.'],
      });
      expect(result.isolation?.record.repositoryRoot).toBe(repository);
      expect(result.isolation?.record.workingDirectory).toBe('packages/app');
      expect(result.isolation?.record.requestedScopes).toEqual([
        'packages/app',
      ]);
      expect(result.isolation?.record.writablePaths[0]).toMatch(
        /packages\/app$/,
      );
      const spawn = isolationSpawn(
        result.isolation as NonNullable<typeof result.isolation>,
        '/bin/pwd',
        [],
      );
      expect(spawn.cwd).toBe(
        path.join(
          result.isolation?.record.worktreePath as string,
          'packages/app',
        ),
      );
      await discardIsolation(result.isolation?.record.id as string);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'captures aborted child lifecycle and permits explicit cleanup',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-aborted.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      await markIsolationRunning(prepared.record.id);
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'aborted',
      });
      expect(captured.status).toBe('failed');
      expect(captured.runOwner).toBeUndefined();
      await discardIsolation(captured.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'terminates an actual isolated child on abort and retains a cleanable failed record',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-real-abort.jsonl');
      writeFileSync(sessionPath, '{}\n');
      let prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      prepared = {
        ...prepared,
        record: await markIsolationRunning(prepared.record.id),
      };
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      const fakePi = path.join(bin, 'pi');
      writeFileSync(
        fakePi,
        '#!/bin/sh\ntest -f "$PI_CODING_AGENT_DIR/auth.json" || exit 42\ntest -z "$PI_ISOLATION_TEST_SECRET" || exit 43\nsleep 30\n',
      );
      chmodSync(fakePi, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}:${previousPath ?? ''}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const run = await runDelegate({
          cwd: prepared.record.worktreePath,
          task: 'abort fixture',
          context: 'fresh',
          sessionPath,
          allowWrites: true,
          writeRequested: true,
          isolation: prepared,
          timeoutMs: 10_000,
          killGraceMs: 100,
          maxConcurrency: 1,
          signal: controller.signal,
          makeDetails: (runs) => ({ mode: 'single', runs }),
        });
        expect(getRunState(run)).toBe('aborted');
        expect(
          existsSync(path.join(prepared.record.scratchPath, 'agent')),
        ).toBe(false);
        const captured = await captureIsolationPatch(prepared.record.id, {
          outcome: 'aborted',
        });
        expect(captured.status).toBe('failed');
        expect(captured.runOwner).toBeUndefined();
        await discardIsolation(captured.id);
      } finally {
        clearTimeout(timer);
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
  );

  test('falls back to read-only for dirty and untracked repositories', async () => {
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'dirty\n');
    writeFileSync(path.join(repository, 'untracked.txt'), 'user work\n');
    const result = await prepareWritableIsolation({
      cwd: repository,
      scopes: ['src'],
    });
    expect(result.isolation).toBeUndefined();
    expect(result.fallbackReason).toMatch(/dirty/);
  });

  test('rejects scopes escaping through symlinks', async () => {
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(repository, 'escape'));
    git(repository, ['add', 'escape']);
    git(repository, ['commit', '-qm', 'tracked escape fixture']);
    const result = await prepareWritableIsolation({
      cwd: repository,
      scopes: ['escape'],
    });
    expect(result.isolation).toBeUndefined();
    expect(result.fallbackReason).toMatch(/scope escapes/);
  });
});
