import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalStateDir = process.env.PI_DELEGATE_STATE_DIR;

export let root: string;
export let agentDir: string;
export let repository: string;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

beforeEach(() => {
  // Resolved through realpath because macOS hands out /var symlinks for temp
  // directories, and git reports the canonical path back to us.
  root = execFileSync(
    'realpath',
    [mkdtempSync(path.join(tmpdir(), 'delegate-worktree-'))],
    { encoding: 'utf8' },
  ).trim();
  agentDir = path.join(root, 'agent');
  repository = path.join(root, 'repository');
  mkdirSync(agentDir);
  mkdirSync(repository);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_DELEGATE_STATE_DIR = path.join(agentDir, 'state');

  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  git(repository, ['config', 'user.name', 'Test']);
  mkdirSync(path.join(repository, 'src'));
  writeFileSync(path.join(repository, '.gitignore'), 'node_modules/\n.env\n');
  writeFileSync(
    path.join(repository, 'package.json'),
    '{"name":"fixture","version":"1.0.0"}\n',
  );
  writeFileSync(path.join(repository, 'src', 'value.txt'), 'one\n');
  mkdirSync(path.join(repository, 'node_modules', 'fixture'), {
    recursive: true,
  });
  writeFileSync(
    path.join(repository, 'node_modules', 'fixture', 'index.js'),
    'module.exports = 1;\n',
  );
  writeFileSync(path.join(repository, '.env'), 'SECRET=local\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-qm', 'fixture']);
});

afterEach(() => {
  restoreEnv('PI_CODING_AGENT_DIR', originalAgentDir);
  restoreEnv('PI_DELEGATE_STATE_DIR', originalStateDir);
  rmSync(root, { recursive: true, force: true });
});
