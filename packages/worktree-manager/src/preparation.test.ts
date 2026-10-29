import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createWorktreeCreator } from './create.js';
import { createWorktreeFinisher } from './finish.js';
import * as gitCommands from './git.js';
import { createWorktreeIntegrator } from './integrate.js';
import type { WorktreeRecord } from './model.js';

const exec = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-preparation-'));
  await exec('git', ['-C', root, 'init', '-b', 'main']);
  await exec('git', ['-C', root, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', root, 'config', 'user.email', 'test@example.test']);
  await writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, 'commit', '-m', 'base']);
  return root;
}

function diskStore(file: string) {
  return {
    loadWorktree: (_id: string): WorktreeRecord | undefined =>
      existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined,
    writeWorktreeRecord: (record: WorktreeRecord) =>
      writeFileSync(file, JSON.stringify(record)),
    deleteWorktreeRecord: (_id: string) => rmSync(file, { force: true }),
  };
}

describe('fresh worktree ownership', () => {
  it('keeps concurrent same-name preparations independent', async () => {
    const root = await repository();
    const records = new Map<string, WorktreeRecord>();
    const creator = createWorktreeCreator({
      loadWorktree: (id) => records.get(id),
      writeWorktreeRecord: (record) =>
        records.set(record.id, structuredClone(record)),
      deleteWorktreeRecord: (id) => records.delete(id),
    });
    const nativeGit = gitCommands.git;
    let scanned = 0;
    let releaseScans = () => {};
    const scansComplete = new Promise<void>((resolve) => {
      releaseScans = resolve;
    });
    const spy = vi
      .spyOn(gitCommands, 'git')
      .mockImplementation(async (cwd, args, options) => {
        const result = await nativeGit(cwd, args, options);
        if (args[0] === 'for-each-ref') {
          if (++scanned === 2) releaseScans();
          await scansComplete;
        }
        return result;
      });
    try {
      const results = await Promise.all([
        creator.prepareWorktree({ cwd: root, name: 'same-name', base: 'head' }),
        creator.prepareWorktree({ cwd: root, name: 'same-name', base: 'head' }),
      ]);
      for (const result of results) {
        if (!result.worktree) continue;
        const { record } = result.worktree;
        expect(existsSync(record.worktreePath)).toBe(true);
        expect(
          await gitCommands.gitText(root, ['rev-parse', record.branch]),
        ).toBe(record.baseHead);
      }
      expect(results.every((result) => result.worktree)).toBe(true);
      expect(
        new Set([...records.values()].map((record) => record.worktreePath))
          .size,
      ).toBe(2);
      expect(
        new Set([...records.values()].map((record) => record.branch)).size,
      ).toBe(2);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains interrupted setup across a process crash until explicit, repeatable cleanup', async () => {
    const root = await repository();
    const state = await mkdtemp(
      path.join(os.tmpdir(), 'pi-preparation-state-'),
    );
    const recordFile = path.join(state, 'record.json');
    const script = path.join(state, 'crash.ts');
    try {
      await writeFile(
        script,
        `
        import { writeFileSync } from 'node:fs';
        import { createWorktreeCreator } from ${JSON.stringify(fileURLToPath(new URL('./create.ts', import.meta.url)))};
        const creator = createWorktreeCreator({
          loadWorktree: () => undefined,
          writeWorktreeRecord(record) {
            if (record.status === 'active') process.kill(process.pid, 'SIGKILL');
            writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify(record));
          },
          deleteWorktreeRecord() {},
        });
        await creator.prepareWorktree({ cwd: ${JSON.stringify(root)}, name: 'interrupted', base: 'wip' });
      `,
      );
      await writeFile(path.join(root, 'tracked.txt'), 'parent WIP\n');
      await expect(exec('bun', [script])).rejects.toMatchObject({
        signal: 'SIGKILL',
      });
      const store = diskStore(recordFile);
      const record = store.loadWorktree('interrupted');
      expect(record).toMatchObject({ status: 'preparing', base: 'wip' });
      if (!record) throw new Error('Interrupted preparation record was lost');
      expect(existsSync(record.worktreePath)).toBe(true);
      await writeFile(path.join(root, 'tracked.txt'), 'later parent WIP\n');
      await expect(
        createWorktreeCreator(store).rehydrateWorktree(record),
      ).rejects.toThrow(/interrupted/i);
      expect(store.loadWorktree(record.id)?.status).toBe('preparing');
      expect(readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe(
        'later parent WIP\n',
      );

      const integrator = createWorktreeIntegrator();
      expect(await integrator.branchState(record)).toBe('preparing');
      expect(await integrator.reviewBranch(record)).toMatchObject({
        state: 'preparing',
        error: expect.stringMatching(/incomplete/),
      });
      expect(await integrator.mergeBranch(record)).toMatchObject({
        merged: false,
        reason: expect.stringMatching(/incomplete/),
      });
      const finisher = createWorktreeFinisher(store);
      await expect(
        finisher.finishWorktree(record.id, {
          taskName: 'Interrupted',
          outcome: 'error',
        }),
      ).rejects.toThrow(/incomplete/);
      await expect(finisher.retireWorktreeSnapshot(record.id)).rejects.toThrow(
        /incomplete/,
      );
      await finisher.removeWorktree(record.id, { deleteBranch: true });
      await finisher.removeWorktree(record.id, { deleteBranch: true });
      expect(existsSync(record.worktreePath)).toBe(false);
      expect(store.loadWorktree(record.id)).toBeUndefined();
      await expect(
        gitCommands.gitText(root, ['rev-parse', '--verify', record.branch]),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });
});
