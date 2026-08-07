import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createWorktreeCreator } from './create';
import type { WorktreeRecord } from './model';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args]);
}

describe('worktree creator rehydration', () => {
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
