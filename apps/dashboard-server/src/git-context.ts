import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitContext } from '@pi-dashboard/protocol';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 512 * 1024;
const MAX_BRANCHES = 4096;
function safeBranch(value: string): boolean {
  return (
    value.length > 0 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
    });
    return result.stdout;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw Object.assign(
      new Error(`Git context unavailable: ${message.slice(0, 400)}`),
      { code: 'git-context-unavailable' },
    );
  }
}

/** Read only bounded metadata; no user value is interpolated into a command. */
export async function readGitContext(root: string): Promise<GitContext> {
  const [branchOutput, statusOutput, branchesOutput] = await Promise.all([
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ]);
  const branches = branchesOutput
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => safeBranch(value))
    .slice(0, MAX_BRANCHES);
  const changedFileCount = Math.min(
    statusOutput.split('\n').filter((line) => line.length > 0).length,
    100_000,
  );
  return {
    ...(branchOutput.trim() ? { branch: branchOutput.trim() } : {}),
    dirty: changedFileCount > 0,
    changedFileCount,
    localBranches: branches,
  };
}

export async function resolveGitCommit(
  root: string,
  ref: string | undefined,
): Promise<string> {
  if (ref !== undefined) {
    if (
      !safeBranch(ref) ||
      ref.length > 512 ||
      ref.includes('..') ||
      ref.includes('@{')
    )
      throw new Error('Invalid branch/ref.');
    const context = await readGitContext(root);
    if (!context.localBranches.includes(ref))
      throw new Error('The selected branch no longer exists locally.');
  }
  const args =
    ref === undefined
      ? ['rev-parse', '--verify', 'HEAD^{commit}']
      : ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`];
  const output = await git(root, args);
  const commit = output.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(commit))
    throw new Error('Git returned an invalid commit.');
  return commit;
}
