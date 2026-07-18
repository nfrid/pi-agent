import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import {
  type attachIsolationSession,
  isolationSpawn,
  isolationValidationScript,
  validateIsolationPatch,
} from '../isolation';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalStateDir = process.env.PI_DELEGATE_STATE_DIR;
const originalTestSecret = process.env.PI_ISOLATION_TEST_SECRET;

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
  root = mkdtempSync(path.join(tmpdir(), 'delegate-isolation-'));
  root = execFileSync('realpath', [root], { encoding: 'utf8' }).trim();
  agentDir = path.join(root, 'agent');
  repository = path.join(root, 'repository');
  mkdirSync(agentDir);
  writeFileSync(
    path.join(agentDir, 'auth.json'),
    '{"fixture":{"type":"api_key","key":"test-only"}}\n',
    { mode: 0o600 },
  );
  mkdirSync(repository);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_DELEGATE_STATE_DIR = path.join(agentDir, 'state');
  process.env.PI_ISOLATION_TEST_SECRET = 'must-not-reach-validation';
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  git(repository, ['config', 'user.name', 'Test']);
  mkdirSync(path.join(repository, 'src'));
  mkdirSync(path.join(repository, 'other'));
  writeFileSync(path.join(repository, '.gitignore'), 'node_modules/\n');
  writeFileSync(
    path.join(repository, 'package.json'),
    '{"name":"fixture","version":"1.0.0","scripts":{"check":"node -e \\"process.exit(process.env.PI_ISOLATION_TEST_SECRET ? 1 : 0)\\""}}\n',
  );
  writeFileSync(
    path.join(repository, 'package-lock.json'),
    '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n',
  );
  writeFileSync(path.join(repository, 'src', 'value.txt'), 'one\n');
  mkdirSync(path.join(repository, 'node_modules', 'fixture'), {
    recursive: true,
  });
  writeFileSync(
    path.join(repository, 'node_modules', 'fixture', 'index.js'),
    'module.exports = 1;\n',
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-qm', 'fixture']);
});

afterEach(() => {
  restoreEnv('PI_CODING_AGENT_DIR', originalAgentDir);
  restoreEnv('PI_DELEGATE_STATE_DIR', originalStateDir);
  restoreEnv('PI_ISOLATION_TEST_SECRET', originalTestSecret);
  rmSync(root, { recursive: true, force: true });
});

export function validate(id: string) {
  const script = isolationValidationScript(id, 'check');
  return validateIsolationPatch(id, 'check', script.sha256);
}

export function sandboxRun(
  prepared: ReturnType<typeof attachIsolationSession>,
  script: string,
): ReturnType<typeof spawnSync> {
  const target = isolationSpawn(prepared, '/bin/sh', ['-c', script]);
  return spawnSync(target.command, target.args, {
    cwd: target.cwd,
    env: { ...process.env, ...target.env },
    encoding: 'utf8',
  });
}
