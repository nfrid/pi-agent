import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { IsolationRecord } from './model';
import { delegateStateRoot } from './records';

const execFileAsync = promisify(execFile);
const _SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const READ_ONLY_ROOT = 'delegate-readonly/v1';
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const _SAFE_ID = /^[0-9a-f-]{36}$/;
function _readOnlyRootDir(): string {
  return path.join(delegateStateRoot(), READ_ONLY_ROOT);
}

const _MANIFEST_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

export function canonical(value: string): string {
  return realpathSync(value);
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export async function git(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    encoding?: BufferEncoding | 'buffer';
  } = {},
): Promise<string | Buffer> {
  const encoding = options.encoding ?? 'utf8';
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: options.env,
    encoding: encoding === 'buffer' ? 'buffer' : encoding,
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return result.stdout;
}

export function scratchEnvironment(scratchPath: string): NodeJS.ProcessEnv {
  const home = path.join(scratchPath, 'home');
  const temporary = path.join(scratchPath, 'tmp');
  const cache = path.join(scratchPath, 'cache');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  return {
    HOME: home,
    TMPDIR: temporary,
    XDG_CACHE_HOME: cache,
    npm_config_cache: path.join(cache, 'npm'),
    PI_DELEGATE_ISOLATED: '1',
  };
}

export function delegateChildEnvironment(
  scratchPath: string,
): NodeJS.ProcessEnv {
  const environment = scratchEnvironment(scratchPath);
  const agentDir = path.join(scratchPath, 'agent');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  for (const name of ['auth.json', 'models.json']) {
    const source = path.join(getAgentDir(), name);
    if (!existsSync(source)) continue;
    writeFileSync(path.join(agentDir, name), readFileSync(source), {
      mode: 0o600,
    });
  }
  return {
    ...environment,
    PI_CODING_AGENT_DIR: agentDir,
  };
}

export function isolationEnvironment(
  record: IsolationRecord,
): NodeJS.ProcessEnv {
  return scratchEnvironment(record.scratchPath);
}
