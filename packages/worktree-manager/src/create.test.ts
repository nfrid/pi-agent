import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { captureWorkInProgress, createWorktreeCreator } from './create.js';
import type { WorktreeRecord } from './model.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args]);
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}

describe('work-in-progress capture', () => {
  it('captures the exact source tree without changing the parent checkout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-worktree-capture-'));
    let source: Awaited<ReturnType<typeof captureWorkInProgress>> | undefined;
    try {
      await git(root, 'init', '-b', 'main');
      await git(root, 'config', 'user.email', 'test@example.test');
      await git(root, 'config', 'user.name', 'Test');
      await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
      await writeFile(path.join(root, 'staged.txt'), 'base staged\n');
      await writeFile(path.join(root, 'unstaged.txt'), 'base unstaged\n');
      await git(root, 'add', '.');
      await git(root, 'commit', '-m', 'base');
      await writeFile(path.join(root, 'staged.txt'), 'new staged\n');
      await git(root, 'add', 'staged.txt');
      await writeFile(path.join(root, 'unstaged.txt'), 'new unstaged\n');
      await writeFile(path.join(root, 'untracked.txt'), 'new untracked\n');
      await writeFile(path.join(root, 'ignored.txt'), 'must not capture\n');

      const statusBefore = await gitText(
        root,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      );
      const indexBefore = await readFile(path.join(root, '.git', 'index'));
      source = await captureWorkInProgress(root);

      expect(source.repositoryRoot).toBe(
        await gitText(root, 'rev-parse', '--show-toplevel'),
      );
      expect(source.baseHead).not.toBe(source.snapshotCommit);
      expect(source.carriedWip).toBe(true);
      expect(source.carryCommit).toBe(source.snapshotCommit);
      expect(
        (
          await gitText(
            root,
            'ls-tree',
            '-r',
            '--name-only',
            source.snapshotCommit,
          )
        ).split('\n'),
      ).toEqual(['.gitignore', 'staged.txt', 'unstaged.txt', 'untracked.txt']);
      expect(
        await gitText(root, 'show', `${source.snapshotCommit}:staged.txt`),
      ).toBe('new staged');
      expect(
        await gitText(root, 'show', `${source.snapshotCommit}:unstaged.txt`),
      ).toBe('new unstaged');
      expect(
        await gitText(root, 'show', `${source.snapshotCommit}:untracked.txt`),
      ).toBe('new untracked');
      expect(await gitText(root, 'rev-parse', '--verify', source.ref)).toBe(
        source.snapshotCommit,
      );

      expect(await readFile(path.join(root, '.git', 'index'))).toEqual(
        indexBefore,
      );
      expect(
        await gitText(
          root,
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
        ),
      ).toBe(statusBefore);

      await source.dispose();
      await source.dispose();
      await expect(
        gitText(root, 'rev-parse', '--verify', source.ref),
      ).rejects.toThrow();
    } finally {
      await source?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pins a clean HEAD and cleans up an aborted capture', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-worktree-clean-'));
    let source: Awaited<ReturnType<typeof captureWorkInProgress>> | undefined;
    try {
      await git(root, 'init', '-b', 'main');
      await git(root, 'config', 'user.email', 'test@example.test');
      await git(root, 'config', 'user.name', 'Test');
      await writeFile(path.join(root, 'tracked.txt'), 'clean\n');
      await git(root, 'add', '.');
      await git(root, 'commit', '-m', 'base');
      const head = await gitText(root, 'rev-parse', 'HEAD');
      source = await captureWorkInProgress(root);
      expect(source.baseHead).toBe(head);
      expect(source.snapshotCommit).toBe(head);
      expect(source.carriedWip).toBe(false);
      expect(source.carryCommit).toBeUndefined();
      await source.dispose();

      const controller = new AbortController();
      controller.abort(new Error('cancelled'));
      await expect(
        captureWorkInProgress(root, { signal: controller.signal }),
      ).rejects.toThrow('cancelled');
      expect(
        await gitText(
          root,
          'for-each-ref',
          '--format=%(refname)',
          'refs/private/pi-worktree-manager/wip',
        ),
      ).toBe('');
    } finally {
      await source?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('worktree creator rehydration', () => {
  it('starts from a captured immutable WIP ref after the parent changes', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-worktree-captured-ref-'),
    );
    let source: Awaited<ReturnType<typeof captureWorkInProgress>> | undefined;
    const records = new Map<string, WorktreeRecord>();
    const store = {
      loadWorktree: (id: string) => records.get(id),
      writeWorktreeRecord: (record: WorktreeRecord) =>
        records.set(record.id, record),
      deleteWorktreeRecord: (id: string) => records.delete(id),
    };
    try {
      await git(root, 'init', '-b', 'main');
      await git(root, 'config', 'user.email', 'test@example.test');
      await git(root, 'config', 'user.name', 'Test');
      await writeFile(path.join(root, 'tracked.txt'), 'base\n');
      await git(root, 'add', '.');
      await git(root, 'commit', '-m', 'base');
      await writeFile(path.join(root, 'tracked.txt'), 'captured\n');
      await writeFile(path.join(root, 'captured.txt'), 'captured untracked\n');
      source = await captureWorkInProgress(root);
      await writeFile(path.join(root, 'tracked.txt'), 'later\n');
      await writeFile(path.join(root, 'later.txt'), 'later untracked\n');

      const creator = createWorktreeCreator(store);
      const prepared = await creator.prepareWorktree({
        cwd: root,
        name: 'captured',
        baseRef: source.ref,
      });
      if (!prepared.worktree) throw new Error('worktree was not prepared');
      expect(
        await readFile(
          path.join(prepared.worktree.record.worktreePath, 'tracked.txt'),
          'utf8',
        ),
      ).toBe('captured\n');
      expect(
        await readFile(
          path.join(prepared.worktree.record.worktreePath, 'captured.txt'),
          'utf8',
        ),
      ).toBe('captured untracked\n');
      expect(
        existsSync(
          path.join(prepared.worktree.record.worktreePath, 'later.txt'),
        ),
      ).toBe(false);
      expect(prepared.worktree.record.baseRef).toBe(source.ref);
      await source.dispose();
      source = undefined;
      await git(
        root,
        'worktree',
        'remove',
        '--force',
        prepared.worktree.record.worktreePath,
      );
      await git(root, 'branch', '-D', prepared.worktree.record.branch);
    } finally {
      await source?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('starts a fresh worktree from an explicit branch/ref and records provenance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-worktree-base-ref-'));
    const records = new Map<string, WorktreeRecord>();
    const store = {
      loadWorktree: (id: string) => records.get(id),
      writeWorktreeRecord: (record: WorktreeRecord) =>
        records.set(record.id, record),
      deleteWorktreeRecord: (id: string) => records.delete(id),
    };
    try {
      await git(root, 'init', '-b', 'main');
      await git(root, 'config', 'user.email', 'test@example.test');
      await git(root, 'config', 'user.name', 'Test');
      await writeFile(path.join(root, 'tracked.txt'), 'base\n');
      await git(root, 'add', '.');
      await git(root, 'commit', '-m', 'base');
      await git(root, 'branch', 'configured-base');
      await writeFile(path.join(root, 'tracked.txt'), 'wip\n');
      const creator = createWorktreeCreator(store);
      const prepared = await creator.prepareWorktree({
        cwd: root,
        name: 'configured',
        baseRef: 'configured-base',
      });
      if (!prepared.worktree) throw new Error('worktree was not prepared');
      expect(prepared.worktree.record.base).toBe('head');
      expect(prepared.worktree.record.baseRef).toBe('configured-base');
      expect(prepared.worktree.record.carriedWip).toBe(false);
      expect(
        await readFile(
          path.join(prepared.worktree.record.worktreePath, 'tracked.txt'),
          'utf8',
        ),
      ).toBe('base\n');
      await git(
        root,
        'worktree',
        'remove',
        '--force',
        prepared.worktree.record.worktreePath,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refreshes active status and updatedAt for extant and recreated checkouts', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-worktree-rehydrate-'),
    );
    const records = new Map<string, WorktreeRecord>();
    const store = {
      loadWorktree: (id: string) => records.get(id),
      writeWorktreeRecord: (record: WorktreeRecord) => {
        records.set(record.id, record);
      },
      deleteWorktreeRecord: (id: string) => {
        records.delete(id);
      },
    };
    try {
      await git(root, 'init', '-b', 'main');
      await git(root, 'config', 'user.email', 'test@example.test');
      await git(root, 'config', 'user.name', 'Test');
      await writeFile(path.join(root, 'tracked.txt'), 'base\n');
      await git(root, 'add', '.');
      await git(root, 'commit', '-m', 'base');
      const creator = createWorktreeCreator(store);
      const prepared = await creator.prepareWorktree({
        cwd: root,
        name: 'rehydrate',
        base: 'head',
      });
      if (!prepared.worktree) throw new Error('worktree was not prepared');
      const record = prepared.worktree.record;
      const oldTimestamp = record.updatedAt;
      record.status = 'finished';
      record.snapshot = true;
      store.writeWorktreeRecord(record);
      await creator.rehydrateWorktree(record);
      expect(record.status).toBe('active');
      expect(record.snapshot).toBeUndefined();
      expect(Date.parse(record.updatedAt)).toBeGreaterThan(
        Date.parse(oldTimestamp),
      );

      const recreatedTimestamp = record.updatedAt;
      await git(root, 'worktree', 'remove', '--force', record.worktreePath);
      await git(root, 'worktree', 'prune');
      record.status = 'finished';
      record.snapshot = true;
      store.writeWorktreeRecord(record);
      await creator.rehydrateWorktree(record);
      expect(record.status).toBe('active');
      expect(record.snapshot).toBeUndefined();
      expect(Date.parse(record.updatedAt)).toBeGreaterThan(
        Date.parse(recreatedTimestamp),
      );
      await git(root, 'worktree', 'remove', '--force', record.worktreePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
