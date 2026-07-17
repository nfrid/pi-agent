import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const ROOT = 'delegate-worktrees/v1';
const READ_ONLY_ROOT = 'delegate-readonly/v1';
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const SAFE_ID = /^[0-9a-f-]{36}$/;
const MANIFEST_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

export type DependencyMode = 'auto' | 'link' | 'isolated';
export type EffectiveDependencyMode = 'link' | 'isolated';

export interface IsolationRecord {
  version: 1;
  id: string;
  sessionToken?: string;
  repositoryRoot: string;
  worktreePath: string;
  workingDirectory: string;
  scratchPath: string;
  baseHead: string;
  requestedScopes: string[];
  writablePaths: string[];
  requestedDependencyMode: DependencyMode;
  dependencyMode: EffectiveDependencyMode;
  dependencyLinks: string[];
  manifestHash: string;
  backend: 'macos-sandbox-exec';
  createdAt: string;
  updatedAt: string;
  runOutcome?: 'success' | 'error' | 'aborted' | 'timed-out' | 'unknown';
  runOwner?: {
    pid: number;
    identity: string;
    startedAt: string;
  };
  validation?: {
    status: 'not-run' | 'passed' | 'failed';
    script?: string;
    scriptSha256?: string;
    exitCode?: number;
    outputSha256?: string;
    validatedAt?: string;
    reason?: string;
  };
  status:
    | 'prepared'
    | 'running'
    | 'ran'
    | 'patch-ready'
    | 'no-changes'
    | 'applied'
    | 'discarded'
    | 'conflicted'
    | 'failed';
  patch?: {
    sha256: string;
    size: number;
    changedPaths: string[];
    diffCheckPassed: boolean;
    requiresIsolatedDependencyValidation: boolean;
    unsafeReason?: string;
  };
  error?: string;
}

export interface PreparedIsolation {
  record: IsolationRecord;
  profilePath: string;
  env: NodeJS.ProcessEnv;
}

export interface IsolationPreparation {
  isolation?: PreparedIsolation;
  fallbackReason?: string;
}

export interface PreparedChildAuth {
  directory: string;
  env: NodeJS.ProcessEnv;
}

export interface PreparedReadOnlySandbox {
  id: string;
  cwd: string;
  directory: string;
  profilePath: string;
  shellProfilePath: string;
  env: NodeJS.ProcessEnv;
}

export function delegateStateRoot(): string {
  return (
    process.env.PI_DELEGATE_STATE_DIR ??
    path.join(
      process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state'),
      'pi-agent',
    )
  );
}

function rootDir(): string {
  return path.join(delegateStateRoot(), ROOT);
}

function readOnlyRootDir(): string {
  return path.join(delegateStateRoot(), READ_ONLY_ROOT);
}

function recordDir(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('Invalid isolation identifier');
  return path.join(rootDir(), id);
}

function recordPath(id: string): string {
  return path.join(recordDir(id), 'record.json');
}

function canonical(value: string): string {
  return realpathSync(value);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function git(
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

function writeRecord(record: IsolationRecord): void {
  record.updatedAt = new Date().toISOString();
  const target = recordPath(record.id);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, target);
}

export function loadIsolation(id: string): IsolationRecord | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(recordPath(id), 'utf8'),
    ) as IsolationRecord;
    return parsed.version === 1 && parsed.id === id
      ? { ...parsed, workingDirectory: parsed.workingDirectory ?? '' }
      : undefined;
  } catch {
    return undefined;
  }
}

export function listIsolations(): IsolationRecord[] {
  if (!existsSync(rootDir())) return [];
  return readdirSync(rootDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .map((entry) => loadIsolation(entry.name))
    .filter((record): record is IsolationRecord => Boolean(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function sandboxBackendAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

async function repositoryRoot(cwd: string): Promise<string> {
  const raw = String(await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const root = canonical(raw);
  if (!isInside(root, canonical(cwd)))
    throw new Error('cwd is outside repository root');
  return root;
}

async function manifestSnapshot(repositoryRoot: string): Promise<{
  hash: string;
  packageDirs: string[];
}> {
  const output = String(
    await git(repositoryRoot, [
      'ls-files',
      '-z',
      '--',
      '**/package.json',
      'package.json',
      '*lock*',
    ]),
  );
  const files = output
    .split('\0')
    .filter(Boolean)
    .filter((file) => MANIFEST_NAMES.has(path.basename(file)))
    .sort();
  const hash = createHash('sha256');
  const packageDirs = new Set<string>();
  for (const file of files) {
    const absolute = path.join(repositoryRoot, file);
    if (!existsSync(absolute)) continue;
    hash.update(file).update('\0').update(readFileSync(absolute)).update('\0');
    if (path.basename(file) === 'package.json')
      packageDirs.add(path.dirname(file));
  }
  return { hash: hash.digest('hex'), packageDirs: [...packageDirs].sort() };
}

function scopePaths(
  repositoryRoot: string,
  cwd: string,
  scopes: string[],
): Array<{
  relative: string;
  directory: boolean;
}> {
  if (scopes.length === 0)
    throw new Error('writable delegation requires scope directories');
  return scopes.map((scope) => {
    const absolute = canonical(path.resolve(cwd, scope));
    if (!isInside(repositoryRoot, absolute))
      throw new Error(`scope escapes repository: ${scope}`);
    return {
      relative: path.relative(repositoryRoot, absolute),
      directory: lstatSync(absolute).isDirectory(),
    };
  });
}

async function patchSafetyReason(
  record: IsolationRecord,
  names: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const name of names) {
    if (
      name.includes('\0') ||
      name.includes('\n') ||
      name.includes('\r') ||
      path.isAbsolute(name) ||
      name.split('/').includes('..') ||
      name.split('/').includes('.git') ||
      name === '.gitmodules'
    )
      return `unsafe patch path: ${JSON.stringify(name)}`;
    const target = path.resolve(record.worktreePath, name);
    if (
      !isInside(record.worktreePath, target) ||
      !record.writablePaths.some((scope) => isInside(scope, target))
    )
      return `patch path is outside enforced scope: ${JSON.stringify(name)}`;
  }
  if (names.length === 0) return;
  const entries = String(
    await git(record.worktreePath, ['ls-files', '-s', '-z', '--', ...names], {
      env,
    }),
  )
    .split('\0')
    .filter(Boolean);
  for (const entry of entries) {
    const match = /^(\d+) ([a-f0-9]+) \d+\t([\s\S]+)$/.exec(entry);
    if (match?.[1] !== '120000') continue;
    const link = String(
      await git(record.worktreePath, ['cat-file', '-p', match[2]], { env }),
    ).trim();
    const target = path.resolve(record.worktreePath, match[3]);
    const resolved = path.resolve(path.dirname(target), link);
    if (
      path.isAbsolute(link) ||
      !isInside(record.worktreePath, resolved) ||
      !record.writablePaths.some((scope) => isInside(scope, resolved))
    )
      return `symlink patch target escapes enforced scope: ${JSON.stringify(match[3])}`;
  }
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

function sandboxProfile(
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

function linkDependencies(
  repositoryRoot: string,
  worktreePath: string,
  packageDirs: string[],
): string[] {
  const links: string[] = [];
  for (const directory of packageDirs.slice(0, 100)) {
    const source = path.join(repositoryRoot, directory, 'node_modules');
    const target = path.join(worktreePath, directory, 'node_modules');
    if (!existsSync(source) || existsSync(target)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(source, target, 'dir');
    links.push(path.relative(worktreePath, target));
  }
  return links;
}

export async function prepareWritableIsolation(options: {
  cwd: string;
  scopes: string[];
  dependencyMode?: DependencyMode;
}): Promise<IsolationPreparation> {
  if (!sandboxBackendAvailable())
    return {
      fallbackReason:
        'No supported OS/container sandbox backend is available; running read-only.',
    };
  let repositoryRootValue: string;
  try {
    repositoryRootValue = await repositoryRoot(options.cwd);
    const status = String(
      await git(repositoryRootValue, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]),
    );
    if (status.trim())
      return {
        fallbackReason:
          'Parent repository is dirty; isolated writes require a clean, exact base and were downgraded to read-only.',
      };
  } catch (error) {
    return {
      fallbackReason: `Writable isolation unavailable: ${error instanceof Error ? error.message : String(error)}. Running read-only.`,
    };
  }

  const id = randomUUID();
  const directory = recordDir(id);
  const worktreePath = path.join(directory, 'worktree');
  const scratchPath = path.join(directory, 'scratch');
  mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
  let worktreeAdded = false;
  try {
    const canonicalCwd = canonical(options.cwd);
    const scopes = scopePaths(
      repositoryRootValue,
      canonicalCwd,
      options.scopes,
    );
    const workingDirectory = path.relative(repositoryRootValue, canonicalCwd);
    const baseHead = String(
      await git(repositoryRootValue, ['rev-parse', 'HEAD']),
    ).trim();
    await git(repositoryRootValue, [
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '--detach',
      '--lock',
      '--reason',
      `pi delegate ${id}`,
      worktreePath,
      baseHead,
    ]);
    worktreeAdded = true;
    const snapshot = await manifestSnapshot(repositoryRootValue);
    const requestedDependencyMode = options.dependencyMode ?? 'auto';
    const dependencyLinks =
      requestedDependencyMode === 'isolated'
        ? []
        : linkDependencies(
            repositoryRootValue,
            worktreePath,
            snapshot.packageDirs,
          );
    const dependencyMode: EffectiveDependencyMode =
      requestedDependencyMode === 'isolated' || dependencyLinks.length === 0
        ? 'isolated'
        : 'link';
    const writablePaths = scopes.map(({ relative }) =>
      path.join(worktreePath, relative),
    );
    const now = new Date().toISOString();
    const record: IsolationRecord = {
      version: 1,
      id,
      repositoryRoot: repositoryRootValue,
      worktreePath,
      workingDirectory,
      scratchPath,
      baseHead,
      requestedScopes: scopes.map(({ relative }) => relative || '.'),
      writablePaths,
      requestedDependencyMode,
      dependencyMode,
      dependencyLinks,
      manifestHash: snapshot.hash,
      backend: 'macos-sandbox-exec',
      createdAt: now,
      updatedAt: now,
      status: 'prepared',
    };
    writeRecord(record);
    return {
      isolation: {
        record,
        profilePath: path.join(scratchPath, 'sandbox.sb'),
        env: {},
      },
    };
  } catch (error) {
    let cleanupError: string | undefined;
    if (worktreeAdded) {
      try {
        await git(repositoryRootValue, ['worktree', 'unlock', worktreePath]);
      } catch {
        // An unlocked worktree is also removable.
      }
      try {
        await git(repositoryRootValue, [
          'worktree',
          'remove',
          '--force',
          worktreePath,
        ]);
      } catch (cleanup) {
        cleanupError =
          cleanup instanceof Error ? cleanup.message : String(cleanup);
      }
    }
    if (cleanupError) {
      writeFileSync(
        path.join(directory, 'recovery.json'),
        `${JSON.stringify({ version: 1, id, repositoryRoot: repositoryRootValue, worktreePath, scratchPath, status: 'failed', error: error instanceof Error ? error.message : String(error), cleanupError }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } else {
      rmSync(directory, { recursive: true, force: true });
    }
    return {
      fallbackReason: `Writable isolation setup failed: ${error instanceof Error ? error.message : String(error)}.${cleanupError ? ` Recovery ${id} was retained because cleanup failed.` : ''} Running read-only.`,
    };
  }
}

function scratchEnvironment(scratchPath: string): NodeJS.ProcessEnv {
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

function delegateChildEnvironment(scratchPath: string): NodeJS.ProcessEnv {
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

function isolationEnvironment(record: IsolationRecord): NodeJS.ProcessEnv {
  return scratchEnvironment(record.scratchPath);
}

export function scrubIsolationCredentials(
  isolation: PreparedIsolation | undefined,
): void {
  if (isolation)
    rmSync(path.join(isolation.record.scratchPath, 'agent'), {
      recursive: true,
      force: true,
    });
}

function writeCredentialOwner(directory: string): void {
  writeFileSync(
    path.join(directory, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

export function prepareChildAuth(): PreparedChildAuth {
  const directory = path.join(readOnlyRootDir(), randomUUID());
  const scratchPath = path.join(directory, 'scratch');
  mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
  writeCredentialOwner(directory);
  return { directory, env: delegateChildEnvironment(scratchPath) };
}

export function scrubChildAuth(auth: PreparedChildAuth | undefined): void {
  const agentDir = auth?.env.PI_CODING_AGENT_DIR;
  if (
    typeof agentDir === 'string' &&
    auth &&
    isInside(auth.directory, path.resolve(agentDir))
  )
    rmSync(agentDir, { recursive: true, force: true });
}

export function discardChildAuth(auth: PreparedChildAuth | undefined): void {
  if (auth) rmSync(auth.directory, { recursive: true, force: true });
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

export function attachIsolationSession(
  isolation: PreparedIsolation,
  token: string,
  sessionPath: string,
): PreparedIsolation {
  const record = { ...isolation.record, sessionToken: token };
  const profile = sandboxProfile(record, sessionPath);
  writeFileSync(isolation.profilePath, profile, {
    encoding: 'utf8',
    mode: 0o600,
  });
  writeRecord(record);
  return {
    record,
    profilePath: isolation.profilePath,
    env: delegateChildEnvironment(record.scratchPath),
  };
}

export function restoreIsolationSession(
  record: IsolationRecord,
  token: string,
  sessionPath: string,
): PreparedIsolation {
  if (!existsSync(record.worktreePath) || !existsSync(record.scratchPath))
    throw new Error('Isolated worktree is unavailable');
  if (record.sessionToken && record.sessionToken !== token)
    throw new Error('Isolation belongs to another delegate session');
  if (
    record.status === 'applied' ||
    record.status === 'discarded' ||
    record.status === 'conflicted'
  )
    throw new Error(`Isolation is already ${record.status}`);
  return attachIsolationSession(
    {
      record,
      profilePath: path.join(record.scratchPath, 'sandbox.sb'),
      env: {},
    },
    token,
    sessionPath,
  );
}

export async function markIsolationRunning(
  id: string,
): Promise<IsolationRecord> {
  return withIsolationLock(id, async () => {
    const record = loadIsolation(id);
    if (!record) throw new Error('Isolation record not found');
    if (
      record.status === 'applied' ||
      record.status === 'discarded' ||
      record.status === 'conflicted'
    )
      throw new Error(`Isolation is already ${record.status}`);
    if (
      record.status === 'running' &&
      record.runOwner &&
      processIdentity(record.runOwner.pid) === record.runOwner.identity
    )
      throw new Error('Isolation already has an active delegate run');
    const identity = processIdentity(process.pid);
    if (!identity)
      throw new Error('Cannot establish delegate run owner identity');
    record.status = 'running';
    record.runOwner = {
      pid: process.pid,
      identity,
      startedAt: new Date().toISOString(),
    };
    record.validation = {
      status: 'not-run',
      reason: 'Delegate run is active; recapture and validation are required.',
    };
    writeRecord(record);
    return record;
  });
}

export async function failIsolationRun(
  id: string,
  error: unknown,
): Promise<IsolationRecord> {
  return withIsolationLock(id, async () => {
    const record = loadIsolation(id);
    if (!record) throw new Error('Isolation record not found');
    if (record.status === 'running') {
      record.status = 'failed';
      record.runOwner = undefined;
      record.runOutcome = 'error';
      record.error = `Delegate finalization failed: ${error instanceof Error ? error.message : String(error)}`;
      writeRecord(record);
    }
    return record;
  });
}

export function isolationSpawn(
  isolation: PreparedIsolation,
  command: string,
  args: string[],
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  return {
    command: SANDBOX_EXEC,
    args: ['-f', isolation.profilePath, command, ...args],
    cwd: isolation.record.worktreePath,
    env: isolation.env,
  };
}

async function captureIsolationPatchUnlocked(
  id: string,
  options: {
    outcome?: IsolationRecord['runOutcome'];
  } = {},
): Promise<IsolationRecord> {
  const record = loadIsolation(id);
  if (!record) throw new Error('Isolation record not found');
  if (
    record.status === 'applied' ||
    record.status === 'discarded' ||
    record.status === 'conflicted'
  )
    throw new Error(`Cannot capture an isolation that is ${record.status}`);
  const indexPath = path.join(record.scratchPath, 'patch.index');
  const patchPath = path.join(record.scratchPath, 'changes.patch');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await git(record.worktreePath, ['read-tree', record.baseHead], { env });
    await git(record.worktreePath, ['add', '-A'], { env });
    if (record.dependencyLinks.length > 0)
      await git(
        record.worktreePath,
        ['reset', '-q', record.baseHead, '--', ...record.dependencyLinks],
        { env },
      );
    const patch = (await git(
      record.worktreePath,
      [
        'diff',
        '--cached',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-renames',
        record.baseHead,
      ],
      { env, encoding: 'buffer' },
    )) as Buffer;
    const names = String(
      await git(
        record.worktreePath,
        ['diff', '--cached', '--name-only', '-z', record.baseHead],
        { env },
      ),
    )
      .split('\0')
      .filter(Boolean);
    let diffCheckPassed = true;
    try {
      await git(
        record.worktreePath,
        ['diff', '--cached', '--check', record.baseHead],
        { env },
      );
    } catch {
      diffCheckPassed = false;
    }
    const requiresIsolatedDependencyValidation = names.some((name) =>
      MANIFEST_NAMES.has(path.basename(name)),
    );
    const unsafeReason = await patchSafetyReason(record, names, env);
    diffCheckPassed = diffCheckPassed && !unsafeReason;
    writeFileSync(patchPath, patch, { mode: 0o600 });
    record.runOutcome = options.outcome ?? record.runOutcome ?? 'unknown';
    record.runOwner = undefined;
    record.status =
      record.runOutcome !== 'success'
        ? 'failed'
        : patch.length === 0
          ? 'no-changes'
          : 'patch-ready';
    record.validation = {
      status: 'not-run',
      reason: 'Controlled validation has not run for this patch hash.',
    };
    record.patch = {
      sha256: createHash('sha256').update(patch).digest('hex'),
      size: patch.length,
      changedPaths: names,
      diffCheckPassed,
      requiresIsolatedDependencyValidation,
      ...(unsafeReason ? { unsafeReason } : {}),
    };
    writeRecord(record);
    return record;
  } catch (error) {
    record.runOwner = undefined;
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    writeRecord(record);
    return record;
  } finally {
    rmSync(indexPath, { force: true });
  }
}

export async function captureIsolationPatch(
  id: string,
  options: {
    outcome?: IsolationRecord['runOutcome'];
  } = {},
): Promise<IsolationRecord> {
  return withIsolationLock(id, () =>
    captureIsolationPatchUnlocked(id, options),
  );
}

export function isolationPatchBytes(
  record: IsolationRecord,
): Buffer | undefined {
  const patchPath = path.join(record.scratchPath, 'changes.patch');
  if (!record.patch || !existsSync(patchPath)) return;
  const bytes = readFileSync(patchPath);
  return createHash('sha256').update(bytes).digest('hex') ===
    record.patch.sha256
    ? bytes
    : undefined;
}

interface ValidationCommands {
  install?: { command: string; args: string[] };
  run: { command: string; args: string[] };
  scriptDefinition: string;
  scriptSha256: string;
}

function validationCommands(
  record: IsolationRecord,
  script: string,
): ValidationCommands {
  if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(script))
    throw new Error('Validation script name is invalid');
  const packageFile = path.join(record.worktreePath, 'package.json');
  if (!existsSync(packageFile))
    throw new Error(
      'Controlled validation currently requires a root package.json',
    );
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) as {
    scripts?: Record<string, unknown>;
  };
  if (typeof packageJson.scripts?.[script] !== 'string')
    throw new Error(`Package script ${script} is not defined`);
  const scriptDefinition = packageJson.scripts[script] as string;
  const scriptDetails = {
    scriptDefinition,
    scriptSha256: createHash('sha256').update(scriptDefinition).digest('hex'),
  };
  if (
    existsSync(path.join(record.worktreePath, 'pnpm-lock.yaml')) ||
    existsSync(path.join(record.worktreePath, 'pnpm-workspace.yaml'))
  )
    return {
      install: {
        command: 'pnpm',
        args: ['install', '--frozen-lockfile', '--ignore-scripts', '--offline'],
      },
      run: { command: 'pnpm', args: ['run', script] },
      ...scriptDetails,
    };
  if (existsSync(path.join(record.worktreePath, 'yarn.lock')))
    return {
      install: {
        command: 'yarn',
        args: ['install', '--frozen-lockfile', '--ignore-scripts', '--offline'],
      },
      run: { command: 'yarn', args: ['run', script] },
      ...scriptDetails,
    };
  if (
    existsSync(path.join(record.worktreePath, 'bun.lock')) ||
    existsSync(path.join(record.worktreePath, 'bun.lockb'))
  )
    return {
      install: {
        command: 'bun',
        args: ['install', '--frozen-lockfile', '--ignore-scripts', '--offline'],
      },
      run: { command: 'bun', args: ['run', script] },
      ...scriptDetails,
    };
  if (
    existsSync(path.join(record.worktreePath, 'package-lock.json')) ||
    existsSync(path.join(record.worktreePath, 'npm-shrinkwrap.json'))
  )
    return {
      install: {
        command: 'npm',
        args: [
          'ci',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--offline',
        ],
      },
      run: { command: 'npm', args: ['run', script] },
      ...scriptDetails,
    };
  return {
    run: { command: 'npm', args: ['run', script] },
    ...scriptDetails,
  };
}

function validationCommand(argv: string[]): ValidationCommands {
  if (
    argv.length === 0 ||
    argv.length > 100 ||
    argv.some(
      (item) =>
        typeof item !== 'string' ||
        item.length === 0 ||
        item.length > 4096 ||
        /[\0\r\n]/.test(item),
    ) ||
    argv.reduce((size, item) => size + item.length, 0) > 32 * 1024
  )
    throw new Error('Controlled validation argv is invalid');
  const scriptDefinition = JSON.stringify(argv);
  return {
    run: { command: argv[0], args: argv.slice(1) },
    scriptDefinition,
    scriptSha256: createHash('sha256').update(scriptDefinition).digest('hex'),
  };
}

export function isolationValidationCommand(
  id: string,
  argv: string[],
): { definition: string; sha256: string } {
  const record = loadIsolation(id);
  if (!record) throw new Error('Isolation record not found');
  if (record.status !== 'patch-ready' || record.runOutcome !== 'success')
    throw new Error('Patch is not ready for controlled validation');
  const commands = validationCommand(argv);
  return {
    definition: commands.scriptDefinition,
    sha256: commands.scriptSha256,
  };
}

export function isolationValidationScript(
  id: string,
  script: string,
): { definition: string; sha256: string } {
  const record = loadIsolation(id);
  if (!record) throw new Error('Isolation record not found');
  if (record.status !== 'patch-ready' || record.runOutcome !== 'success')
    throw new Error('Patch is not ready for controlled validation');
  const commands = validationCommands(record, script);
  return {
    definition: commands.scriptDefinition,
    sha256: commands.scriptSha256,
  };
}

async function runValidationCommand(
  record: IsolationRecord,
  command: string,
  args: string[],
): Promise<{ output: Buffer; exitCode: number }> {
  const profilePath = path.join(record.scratchPath, 'validation.sb');
  const validationRecord = {
    ...record,
    writablePaths: [record.worktreePath],
  };
  writeFileSync(
    profilePath,
    sandboxProfile(validationRecord, '/dev/null', {
      denyNetwork: true,
      denySignal: true,
    }),
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  try {
    const result = await execFileAsync(
      SANDBOX_EXEC,
      ['-f', profilePath, command, ...args],
      {
        cwd: record.worktreePath,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C',
          CI: '1',
          NO_COLOR: '1',
          ...isolationEnvironment(record),
        },
        encoding: 'buffer',
        maxBuffer: MAX_GIT_OUTPUT,
        timeout: 15 * 60_000,
      },
    );
    return {
      output: Buffer.concat([
        Buffer.from(result.stdout ?? ''),
        Buffer.from(result.stderr ?? ''),
      ]),
      exitCode: 0,
    };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return {
      output: Buffer.concat([
        Buffer.from(failure.stdout ?? ''),
        Buffer.from(failure.stderr ?? ''),
      ]),
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    };
  }
}

async function validateIsolationPatchUnlocked(
  id: string,
  target: { script: string } | { argv: string[] },
  expectedScriptSha256: string,
): Promise<IsolationRecord> {
  let record = loadIsolation(id);
  if (!record?.patch || record.status !== 'patch-ready')
    throw new Error('Patch is not ready for validation');
  if (record.runOutcome !== 'success')
    throw new Error(
      `Delegate run outcome is ${record.runOutcome ?? 'unknown'}`,
    );
  const beforeHash = record.patch.sha256;
  const commands =
    'script' in target
      ? validationCommands(record, target.script)
      : validationCommand(target.argv);
  const label =
    'script' in target ? target.script : `command:${target.argv[0]}`;
  if (commands.scriptSha256 !== expectedScriptSha256)
    throw new Error(
      'Validation script changed after confirmation; inspect and confirm the new definition.',
    );
  if (record.dependencyLinks.length > 0) {
    for (const link of record.dependencyLinks)
      rmSync(path.join(record.worktreePath, link), {
        recursive: true,
        force: true,
      });
    record.dependencyLinks = [];
    record.dependencyMode = 'isolated';
    record.validation = {
      status: 'not-run',
      reason:
        'Linked dependencies were detached before validation so cache-writing tools cannot mutate parent dependencies.',
    };
    writeRecord(record);
  }
  const outputs: Buffer[] = [];
  const needsInstall =
    !existsSync(path.join(record.worktreePath, 'node_modules')) &&
    commands.install !== undefined;
  if (record.patch.requiresIsolatedDependencyValidation && !commands.install) {
    record.validation = {
      status: 'failed',
      script: label,
      scriptSha256: commands.scriptSha256,
      reason:
        'Dependency manifests changed without a supported frozen lockfile.',
      validatedAt: new Date().toISOString(),
    };
    writeRecord(record);
    return record;
  }
  if (needsInstall && commands.install) {
    const installed = await runValidationCommand(
      record,
      commands.install.command,
      commands.install.args,
    );
    outputs.push(installed.output);
    if (installed.exitCode !== 0) {
      record.validation = {
        status: 'failed',
        script: label,
        scriptSha256: commands.scriptSha256,
        exitCode: installed.exitCode,
        outputSha256: createHash('sha256')
          .update(Buffer.concat(outputs))
          .digest('hex'),
        reason: 'Frozen, script-disabled dependency installation failed.',
        validatedAt: new Date().toISOString(),
      };
      writeRecord(record);
      return record;
    }
  }
  const validation = await runValidationCommand(
    record,
    commands.run.command,
    commands.run.args,
  );
  outputs.push(validation.output);
  record = await captureIsolationPatchUnlocked(id, { outcome: 'success' });
  const outputSha256 = createHash('sha256')
    .update(Buffer.concat(outputs))
    .digest('hex');
  if (validation.exitCode !== 0) {
    record.validation = {
      status: 'failed',
      script: label,
      scriptSha256: commands.scriptSha256,
      exitCode: validation.exitCode,
      outputSha256,
      reason: 'Controlled validation command failed.',
      validatedAt: new Date().toISOString(),
    };
  } else if (!record.patch?.diffCheckPassed) {
    record.validation = {
      status: 'failed',
      script: label,
      scriptSha256: commands.scriptSha256,
      exitCode: 0,
      outputSha256,
      reason:
        record.patch?.unsafeReason ??
        'Patch failed whitespace/error validation.',
      validatedAt: new Date().toISOString(),
    };
  } else if (record.patch.sha256 !== beforeHash) {
    record.validation = {
      status: 'failed',
      script: label,
      scriptSha256: commands.scriptSha256,
      exitCode: 0,
      outputSha256,
      reason:
        'Validation changed the patch; inspect the new patch and validate again.',
      validatedAt: new Date().toISOString(),
    };
  } else {
    record.validation = {
      status: 'passed',
      script: label,
      scriptSha256: commands.scriptSha256,
      exitCode: 0,
      outputSha256,
      validatedAt: new Date().toISOString(),
    };
  }
  writeRecord(record);
  return record;
}

export async function validateIsolationPatch(
  id: string,
  script: string,
  expectedScriptSha256: string,
): Promise<IsolationRecord> {
  if (!/^[a-f0-9]{64}$/.test(expectedScriptSha256))
    throw new Error('Expected validation script hash is invalid');
  return withIsolationLock(id, () =>
    validateIsolationPatchUnlocked(id, { script }, expectedScriptSha256),
  );
}

export async function validateIsolationCommand(
  id: string,
  argv: string[],
  expectedCommandSha256: string,
): Promise<IsolationRecord> {
  if (!/^[a-f0-9]{64}$/.test(expectedCommandSha256))
    throw new Error('Expected validation command hash is invalid');
  return withIsolationLock(id, () =>
    validateIsolationPatchUnlocked(id, { argv }, expectedCommandSha256),
  );
}

function processIdentity(pid: number): string | undefined {
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return;
  }
}

export function scrubStaleIsolationCredentials(): number {
  let removed = 0;
  if (existsSync(rootDir())) {
    for (const id of readdirSync(rootDir())) {
      if (!SAFE_ID.test(id)) continue;
      const record = loadIsolation(id);
      if (!record) continue;
      const credentialDir = path.join(record.scratchPath, 'agent');
      if (!existsSync(credentialDir)) continue;
      const ownerActive =
        record.runOwner &&
        processIdentity(record.runOwner.pid) === record.runOwner.identity;
      if (ownerActive) continue;
      rmSync(credentialDir, { recursive: true, force: true });
      removed++;
    }
  }
  if (existsSync(readOnlyRootDir())) {
    for (const name of readdirSync(readOnlyRootDir())) {
      const directory = path.join(readOnlyRootDir(), name);
      const credentialDir = path.join(directory, 'scratch', 'agent');
      if (!existsSync(credentialDir)) continue;
      let ownerActive = false;
      try {
        const owner = JSON.parse(
          readFileSync(path.join(directory, 'owner.json'), 'utf8'),
        ) as { pid?: unknown; identity?: unknown };
        ownerActive =
          typeof owner.pid === 'number' &&
          typeof owner.identity === 'string' &&
          processIdentity(owner.pid) === owner.identity;
      } catch {
        ownerActive = false;
      }
      if (ownerActive) continue;
      rmSync(directory, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

function liveLock(lockPath: string): boolean {
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid?: unknown;
      processIdentity?: unknown;
    };
    if (
      typeof lock.pid !== 'number' ||
      typeof lock.processIdentity !== 'string'
    )
      return false;
    process.kill(lock.pid, 0);
    return processIdentity(lock.pid) === lock.processIdentity;
  } catch {
    return false;
  }
}

async function withBrokerLock<T>(
  name: string,
  details: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = path.join(rootDir(), 'locks');
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locks, `${name}.lock`);
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2 && descriptor === undefined; attempt++) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
    } catch {
      if (liveLock(lockPath))
        throw new Error(`Another patch-broker operation holds lock ${name}`);
      try {
        renameSync(lockPath, `${lockPath}.stale-${Date.now()}-${process.pid}`);
      } catch {
        if (attempt === 1)
          throw new Error(`Could not recover stale patch-broker lock ${name}`);
      }
    }
  }
  if (descriptor === undefined)
    throw new Error(`Could not acquire patch-broker lock ${name}`);
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, processIdentity: processIdentity(process.pid), createdAt: new Date().toISOString(), ...details })}\n`,
    );
    return await operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      // The operation is complete; doctor reports any unexpected retained lock.
    }
  }
}

async function withRepositoryLock<T>(
  repositoryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = createHash('sha256').update(repositoryRoot).digest('hex');
  return withBrokerLock(`repository-${key}`, { repositoryRoot }, operation);
}

async function withIsolationLock<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!SAFE_ID.test(id)) throw new Error('Invalid isolation identifier');
  return withBrokerLock(`isolation-${id}`, { isolationId: id }, operation);
}

export type PatchEligibilityCode =
  | 'eligible'
  | 'record-not-ready'
  | 'run-not-successful'
  | 'validation-required'
  | 'unsafe-patch'
  | 'isolated-dependencies-required'
  | 'invalid-patch-bytes'
  | 'unsafe-patch-path'
  | 'stale-parent-head'
  | 'dirty-parent'
  | 'patch-check-failed'
  | 'patch-apply-failed'
  | 'post-apply-conflict';

export interface PatchEligibility {
  eligible: boolean;
  code: PatchEligibilityCode;
  reason: string;
}

export function isolationPatchEligibility(
  record: IsolationRecord | undefined,
): PatchEligibility {
  if (!record?.patch || record.status !== 'patch-ready')
    return {
      eligible: false,
      code: 'record-not-ready',
      reason: 'Patch is not ready for application',
    };
  if (record.runOutcome !== 'success')
    return {
      eligible: false,
      code: 'run-not-successful',
      reason: `Delegate run outcome is ${record.runOutcome ?? 'unknown'}`,
    };
  if (record.validation?.status !== 'passed')
    return {
      eligible: false,
      code: 'validation-required',
      reason:
        record.validation?.reason ?? 'Controlled validation has not passed',
    };
  if (!record.patch.diffCheckPassed)
    return {
      eligible: false,
      code: 'unsafe-patch',
      reason:
        record.patch.unsafeReason ?? 'Patch failed whitespace/error validation',
    };
  if (
    record.patch.requiresIsolatedDependencyValidation &&
    record.dependencyMode !== 'isolated'
  )
    return {
      eligible: false,
      code: 'isolated-dependencies-required',
      reason:
        'Dependency manifests changed; isolated dependency validation is required before application',
    };
  return { eligible: true, code: 'eligible', reason: 'Patch is eligible' };
}

function rejectPatch(code: PatchEligibilityCode, reason: string): never {
  throw new Error(`[${code}] ${reason}`);
}

async function parentChangedPaths(root: string): Promise<string[]> {
  const status = String(
    await git(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]),
  );
  const paths: string[] = [];
  const entries = status.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const name = entry.slice(3);
    if (name) paths.push(name);
    if (code.includes('R') || code.includes('C')) index++;
  }
  return [...new Set(paths)].sort();
}

function changedPathState(root: string, names: string[]): string {
  const hash = createHash('sha256');
  for (const name of names) {
    const target = path.join(root, name);
    hash.update(name).update('\0');
    if (!existsSync(target)) {
      hash.update('deleted\0');
      continue;
    }
    const stat = lstatSync(target);
    hash.update(String(stat.mode)).update('\0');
    if (stat.isSymbolicLink()) hash.update(readlinkSync(target));
    else if (stat.isFile()) hash.update(readFileSync(target));
    else hash.update('directory');
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function applyIsolationPatchUnlocked(
  id: string,
): Promise<IsolationRecord> {
  const record = loadIsolation(id);
  const eligibility = isolationPatchEligibility(record);
  if (!eligibility.eligible) rejectPatch(eligibility.code, eligibility.reason);
  if (!record?.patch)
    rejectPatch('record-not-ready', 'Patch metadata is unavailable');
  const patch = isolationPatchBytes(record);
  if (!patch)
    rejectPatch(
      'invalid-patch-bytes',
      'Patch bytes are missing or failed hash verification',
    );
  if (
    record.patch.changedPaths.some(
      (name) => path.isAbsolute(name) || name.split('/').includes('..'),
    )
  )
    rejectPatch('unsafe-patch-path', 'Patch manifest contains an unsafe path');
  return withRepositoryLock(record.repositoryRoot, async () => {
    const assertFreshParent = async () => {
      const head = String(
        await git(record.repositoryRoot, ['rev-parse', 'HEAD']),
      ).trim();
      if (head !== record.baseHead)
        rejectPatch(
          'stale-parent-head',
          'Parent HEAD changed since delegate isolation',
        );
      const status = String(
        await git(record.repositoryRoot, [
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
        ]),
      );
      if (status.trim())
        rejectPatch(
          'dirty-parent',
          'Parent repository changed since delegate isolation',
        );
    };
    await assertFreshParent();
    const patchPath = path.join(
      record.scratchPath,
      `apply-${record.patch?.sha256}.patch`,
    );
    if (!existsSync(patchPath))
      writeFileSync(patchPath, patch, { mode: 0o600, flag: 'wx' });
    const immutablePatch = readFileSync(patchPath);
    if (
      createHash('sha256').update(immutablePatch).digest('hex') !==
      record.patch?.sha256
    )
      throw new Error('Immutable apply snapshot failed hash verification');
    const expectedState = changedPathState(
      record.worktreePath,
      record.patch?.changedPaths ?? [],
    );
    try {
      await git(record.repositoryRoot, [
        'apply',
        '--check',
        '--whitespace=error-all',
        patchPath,
      ]);
    } catch (error) {
      rejectPatch(
        'patch-check-failed',
        `Patch dry-run failed without changing the parent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await assertFreshParent();
    try {
      await git(record.repositoryRoot, [
        'apply',
        '--whitespace=error-all',
        patchPath,
      ]);
    } catch (error) {
      rejectPatch(
        'patch-apply-failed',
        `Git rejected the patch without a successful application: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const actualState = changedPathState(
      record.repositoryRoot,
      record.patch?.changedPaths ?? [],
    );
    const expectedChangedPaths = [...record.patch.changedPaths].sort();
    const actualChangedPaths = await parentChangedPaths(record.repositoryRoot);
    if (
      actualState !== expectedState ||
      JSON.stringify(actualChangedPaths) !==
        JSON.stringify(expectedChangedPaths)
    ) {
      record.status = 'conflicted';
      record.error =
        '[post-apply-conflict] Concurrent parent drift detected after apply. The patch applied, but external edits prevented a matching postcondition; rollback was refused to avoid overwriting those edits.';
      writeRecord(record);
      throw new Error(record.error);
    }
    record.status = 'applied';
    record.error = undefined;
    writeRecord(record);
    return record;
  });
}

export async function applyIsolationPatch(
  id: string,
): Promise<IsolationRecord> {
  return withIsolationLock(id, () => applyIsolationPatchUnlocked(id));
}

async function discardIsolationUnlocked(id: string): Promise<void> {
  const record = loadIsolation(id);
  if (!record) {
    if (existsSync(path.join(rootDir(), 'archive', `${id}.json`))) return;
    throw new Error('Isolation record not found');
  }
  if (record.status === 'running') {
    if (
      !record.runOwner ||
      processIdentity(record.runOwner.pid) === record.runOwner.identity
    )
      throw new Error('Cannot discard an isolation while its child is running');
    record.status = 'failed';
    record.error = 'Recovered stale running isolation after its owner exited.';
    record.runOwner = undefined;
    writeRecord(record);
  }
  try {
    await git(record.repositoryRoot, [
      'worktree',
      'unlock',
      record.worktreePath,
    ]);
  } catch {
    // Already-unlocked worktrees remain removable.
  }
  try {
    await git(record.repositoryRoot, [
      'worktree',
      'remove',
      '--force',
      record.worktreePath,
    ]);
  } catch (error) {
    record.status = 'failed';
    record.error = `Isolation cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    writeRecord(record);
    throw new Error(record.error);
  }
  record.status = 'discarded';
  const archive = path.join(rootDir(), 'archive');
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(archive, `${record.id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  rmSync(recordDir(id), { recursive: true, force: true });
}

export async function discardIsolation(id: string): Promise<void> {
  return withIsolationLock(id, () => discardIsolationUnlocked(id));
}
