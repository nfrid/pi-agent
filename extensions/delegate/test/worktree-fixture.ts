import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  writeFileSync(
    path.join(repository, '.gitignore'),
    'node_modules/\n.env\n.delegate-setup/\n.delegate-build/\n',
  );
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

export function configureNativeHooks(
  options: {
    failCheckout?: boolean;
    failCommit?: boolean;
    directory?: string;
  } = {},
): string {
  const hooksPath = path.join(root, options.directory ?? 'custom-native-hooks');
  mkdirSync(hooksPath, { recursive: true });
  writeFileSync(
    path.join(hooksPath, 'post-checkout'),
    `#!/bin/sh
set -eu
mkdir -p node_modules/hook-local .delegate-setup .delegate-build
printf '%s\\n' "$PWD" > .delegate-setup/worktree-path
[ -f node_modules/hook-local/README ] || printf 'child-local dependency\\n' > node_modules/hook-local/README
[ -f .delegate-build/cache.txt ] || printf 'child-local build\\n' > .delegate-build/cache.txt
${options.failCheckout ? "printf '%s\\n' 'checkout setup failed' >&2\nexit 23\n" : ''}`,
  );
  chmodSync(path.join(hooksPath, 'post-checkout'), 0o755);
  if (options.failCommit) {
    writeFileSync(
      path.join(hooksPath, 'pre-commit'),
      "#!/bin/sh\nprintf '%s\\n' 'commit hook ran' >&2\nexit 24\n",
    );
    chmodSync(path.join(hooksPath, 'pre-commit'), 0o755);
  }
  git(repository, ['config', 'core.hooksPath', hooksPath]);
  return hooksPath;
}

afterEach(() => {
  restoreEnv('PI_CODING_AGENT_DIR', originalAgentDir);
  restoreEnv('PI_DELEGATE_STATE_DIR', originalStateDir);
  rmSync(root, { recursive: true, force: true });
});
