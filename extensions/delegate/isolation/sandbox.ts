import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { writeCredentialOwner } from './credentials';
import { canonical, delegateChildEnvironment, isInside } from './kernel';
import type {
  IsolationRecord,
  PreparedIsolation,
  PreparedReadOnlySandbox,
} from './model';
import { delegateStateRoot } from './records';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const READ_ONLY_ROOT = 'delegate-readonly/v1';

export function sandboxBackendAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

function sandboxQuote(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r'))
    throw new Error('Sandbox path contains control characters');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function delegateRuntimeReadPaths(): string[] {
  const agentDir = getAgentDir();
  return [
    path.join(agentDir, 'extensions'),
    path.join(agentDir, 'node_modules'),
    path.join(agentDir, 'package.json'),
    path.join(agentDir, 'tsconfig.json'),
  ];
}

function readBoundaryRules(paths: string[]): string[] {
  const home = homedir();
  const rules = [`(deny file-read* (subpath ${sandboxQuote(home)}))`];
  const ancestors = new Set<string>();
  for (const target of paths) {
    let current = path.dirname(target);
    while (isInside(home, current)) {
      ancestors.add(current);
      if (current === home) break;
      current = path.dirname(current);
    }
  }
  for (const ancestor of ancestors)
    rules.push(
      `(allow file-read-metadata (literal ${sandboxQuote(ancestor)}))`,
    );
  for (const target of [...new Set(paths)]) {
    const operator =
      existsSync(target) && !lstatSync(target).isDirectory()
        ? 'literal'
        : 'subpath';
    rules.push(`(allow file-read* (${operator} ${sandboxQuote(target)}))`);
  }
  return rules;
}

export function sandboxProfile(
  record: IsolationRecord,
  sessionPath: string,
  options: { denyNetwork?: boolean; denySignal?: boolean } = {},
): string {
  const writeRules = record.writablePaths.map((target) => {
    const operator =
      existsSync(target) && !lstatSync(target).isDirectory()
        ? 'literal'
        : 'subpath';
    return `(allow file-write* (${operator} ${sandboxQuote(target)}))`;
  });
  const dependencyReads = record.dependencyLinks
    .map((link) => path.join(record.worktreePath, link))
    .filter((target) => existsSync(target))
    .map((target) => canonical(target));
  return [
    '(version 1)',
    '(allow default)',
    ...readBoundaryRules([
      record.worktreePath,
      record.scratchPath,
      sessionPath,
      ...dependencyReads,
      ...delegateRuntimeReadPaths(),
    ]),
    '(deny file-write*)',
    ...(options.denyNetwork ? ['(deny network*)'] : []),
    ...(options.denySignal ? ['(deny signal)'] : []),
    `(allow file-write* (subpath ${sandboxQuote(record.scratchPath)}))`,
    `(allow file-write* (literal ${sandboxQuote(sessionPath)}))`,
    '(allow file-write* (literal "/dev/null"))',
    ...writeRules,
    `(deny file-write* (literal ${sandboxQuote(path.join(record.worktreePath, '.git'))}))`,
    '',
  ].join('\n');
}

export function prepareReadOnlySandbox(
  cwd: string,
  sessionPath: string,
): PreparedReadOnlySandbox | undefined {
  if (!sandboxBackendAvailable()) return;
  const id = randomUUID();
  const directory = path.join(delegateStateRoot(), READ_ONLY_ROOT, id);
  const scratchPath = path.join(directory, 'scratch');
  const profilePath = path.join(directory, 'sandbox.sb');
  const shellProfilePath = path.join(directory, 'inspect-shell.sb');
  try {
    const canonicalCwd = canonical(cwd);
    mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
    writeCredentialOwner(directory);
    const readRules = readBoundaryRules([
      canonicalCwd,
      scratchPath,
      sessionPath,
      ...delegateRuntimeReadPaths(),
    ]);
    const profile = [
      '(version 1)',
      '(allow default)',
      ...readRules,
      '(deny file-write*)',
      `(allow file-write* (subpath ${sandboxQuote(scratchPath)}))`,
      `(allow file-write* (literal ${sandboxQuote(sessionPath)}))`,
      '(allow file-write* (literal "/dev/null"))',
      '',
    ].join('\n');
    writeFileSync(profilePath, profile, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(
      shellProfilePath,
      [
        '(version 1)',
        '(allow default)',
        ...readRules,
        '(deny file-write*)',
        '(deny network*)',
        '(deny signal)',
        `(allow file-write* (subpath ${sandboxQuote(scratchPath)}))`,
        '(allow file-write* (literal "/dev/null"))',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );
    return {
      id,
      cwd: canonicalCwd,
      directory,
      profilePath,
      shellProfilePath,
      env: {
        ...delegateChildEnvironment(scratchPath),
        PI_DELEGATE_READ_ONLY: '1',
        PI_DELEGATE_INSPECT_PROFILE: shellProfilePath,
      },
    };
  } catch {
    rmSync(directory, { recursive: true, force: true });
    return;
  }
}

export function readOnlySandboxSpawn(
  sandbox: PreparedReadOnlySandbox,
  command: string,
  args: string[],
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  return {
    command: SANDBOX_EXEC,
    args: ['-f', sandbox.profilePath, command, ...args],
    cwd: sandbox.cwd,
    env: sandbox.env,
  };
}

export function scrubReadOnlyCredentials(
  sandbox: PreparedReadOnlySandbox | undefined,
): void {
  const agentDir = sandbox?.env.PI_CODING_AGENT_DIR;
  if (
    typeof agentDir === 'string' &&
    sandbox &&
    isInside(sandbox.directory, path.resolve(agentDir))
  )
    rmSync(agentDir, { recursive: true, force: true });
}

export function discardReadOnlySandbox(
  sandbox: PreparedReadOnlySandbox | undefined,
): void {
  if (sandbox) rmSync(sandbox.directory, { recursive: true, force: true });
}

export function isolationSpawn(
  isolation: PreparedIsolation,
  command: string,
  args: string[],
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const worktree = canonical(isolation.record.worktreePath);
  const cwd = canonical(
    path.resolve(worktree, isolation.record.workingDirectory || '.'),
  );
  if (!isInside(worktree, cwd))
    throw new Error('Isolation working directory escapes the worktree');
  return {
    command: SANDBOX_EXEC,
    args: ['-f', isolation.profilePath, command, ...args],
    cwd,
    env: isolation.env,
  };
}
