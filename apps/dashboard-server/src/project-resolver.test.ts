import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectResolver } from './project-resolver.js';

function repository(value: {
  projects: Array<Record<string, unknown>>;
  checkouts: Array<Record<string, unknown>>;
}) {
  return {
    listProjects: () => value.projects,
    listCheckouts: () => value.checkouts,
    getProjectByRepositoryIdentity: (identity: string) =>
      value.projects.find((project) => project.repositoryIdentity === identity),
  } as never;
}

function gitIdentity(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
}

describe('ProjectResolver', () => {
  it('prefers the nearest live checkout and resolves independent Git worktrees', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'dashboard-resolver-git-'),
    );
    const nested = path.join(root, 'nested');
    const independent = path.join(
      path.dirname(root),
      `${path.basename(root)}-independent`,
    );
    await mkdir(nested);
    execFileSync('git', ['-C', root, 'init']);
    execFileSync('git', [
      '-C',
      root,
      'config',
      'user.email',
      'test@example.test',
    ]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    await writeFile(path.join(root, 'tracked.txt'), 'tracked');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, 'commit', '-m', 'base']);
    execFileSync('git', ['-C', root, 'worktree', 'add', independent, 'HEAD']);
    const identity = await realpath(path.resolve(root, gitIdentity(root)));
    const project = {
      id: 'project-git',
      rootPath: root,
      repositoryIdentity: identity,
    };
    const main = {
      id: 'checkout-main',
      projectId: project.id,
      path: root,
      status: 'ready',
    };
    const nestedCheckout = {
      id: 'checkout-nested',
      projectId: project.id,
      path: nested,
      status: 'ready',
    };
    const resolver = new ProjectResolver(
      repository({ projects: [project], checkouts: [main, nestedCheckout] }),
    );
    try {
      expect(resolver.resolve(nested)).toEqual({
        projectId: project.id,
        checkoutId: nestedCheckout.id,
      });
      expect(resolver.resolve(independent)).toEqual({
        projectId: project.id,
        checkoutId: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(independent, { recursive: true, force: true });
    }
  });

  it('resolves registered non-Git roots and explicit unassigned cwd', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'dashboard-resolver-dir-'),
    );
    const outside = await mkdtemp(
      path.join(os.tmpdir(), 'dashboard-resolver-outside-'),
    );
    const project = { id: 'project-dir', rootPath: root };
    const resolver = new ProjectResolver(
      repository({ projects: [project], checkouts: [] }),
    );
    try {
      expect(resolver.resolve(root)).toEqual({
        projectId: project.id,
        checkoutId: null,
      });
      expect(resolver.resolve(outside)).toEqual({
        projectId: null,
        checkoutId: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
