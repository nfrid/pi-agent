import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  delegateStateRoot,
  sandboxBackendAvailable,
} from '../delegate/isolation';
import { nestedRepositoryBoundary } from './policy';
import { canonicalPath, isInside, repositoryRootForPath } from './scope';
import type { CapabilityEnvelope } from './types';

const MAX_OUTPUT = 1024 * 1024;
const MAX_GIT_OUTPUT = 100 * 1024 * 1024;
const GIT_BINARY = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git'
  : '/usr/bin/git';
const SHELL_ROOT = 'autonomy-shell/v1';

function shellRoot(): string {
  return path.join(delegateStateRoot(), SHELL_ROOT);
}

function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function scrubStaleSandboxShellState(): void {
  const runs = path.join(shellRoot(), 'runs');
  if (existsSync(runs))
    for (const name of readdirSync(runs)) {
      const directory = path.join(runs, name);
      try {
        const owner = JSON.parse(
          readFileSync(path.join(directory, 'owner.json'), 'utf8'),
        ) as { pid?: unknown };
        if (!processAlive(owner.pid))
          rmSync(directory, { recursive: true, force: true });
      } catch {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  const locks = path.join(shellRoot(), 'locks');
  if (existsSync(locks))
    for (const name of readdirSync(locks)) {
      const file = path.join(locks, name);
      try {
        const owner = JSON.parse(readFileSync(file, 'utf8')) as {
          pid?: unknown;
        };
        if (!processAlive(owner.pid)) rmSync(file, { force: true });
      } catch {
        rmSync(file, { force: true });
      }
    }
}

export type SandboxShellMode = 'inspect' | 'validate' | 'edit';

export interface SandboxShellResult {
  mode: SandboxShellMode;
  backend: 'macos-sandbox-exec';
  exitCode: number;
  output: string;
  changedPaths: string[];
  applied: boolean;
  patchSha256?: string;
  rejection?: string;
  conflicted?: boolean;
}

function sandboxQuote(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r'))
    throw new Error('Sandbox path contains control characters');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function runtimeReadPaths(): string[] {
  const system = [
    '/bin',
    '/sbin',
    '/usr',
    '/System',
    '/Library',
    '/opt/homebrew',
    '/private/etc',
    '/private/var/db',
    '/private/var/select',
    '/dev',
  ];
  const pathEntries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => existsSync(entry))
    .map((entry) => realpathSync(entry));
  const executable = existsSync(process.execPath)
    ? [path.dirname(realpathSync(process.execPath))]
    : [];
  return [...new Set([...system, ...pathEntries, ...executable])].filter(
    (entry) => existsSync(entry),
  );
}

function readBoundaryRules(
  paths: string[],
  denyPaths: string[] = [],
): string[] {
  const allowed = [...new Set([...runtimeReadPaths(), ...paths])];
  const protectedRoots = [
    '/Users',
    '/Volumes',
    '/Applications',
    '/cores',
    '/home',
    '/opt',
    '/private',
    '/tmp',
  ].filter((target) => existsSync(target));
  const ancestors = new Set<string>(['/']);
  for (const target of allowed) {
    let current = path.dirname(target);
    while (current !== path.dirname(current)) {
      ancestors.add(current);
      current = path.dirname(current);
    }
  }
  return [
    ...protectedRoots.map(
      (target) => `(deny file-read* (subpath ${sandboxQuote(target)}))`,
    ),
    ...[...ancestors].map(
      (ancestor) =>
        `(allow file-read-metadata (literal ${sandboxQuote(ancestor)}))`,
    ),
    ...allowed.map((target) => {
      const operator =
        existsSync(target) && !lstatSync(target).isDirectory()
          ? 'literal'
          : 'subpath';
      return `(allow file-read* (${operator} ${sandboxQuote(target)}))`;
    }),
    ...denyPaths.map(
      (target) => `(deny file-read* (subpath ${sandboxQuote(target)}))`,
    ),
  ];
}

function homeReadBoundaryRules(paths: string[]): string[] {
  const home = process.env.HOME;
  if (!home) return [];
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

function writeBoundaryRules(options: {
  writePaths: string[];
  scratch: string;
  gitDirectories?: string[];
}): string[] {
  return [
    '(deny file-write*)',
    `(allow file-write* (subpath ${sandboxQuote(options.scratch)}))`,
    '(allow file-write* (literal "/dev/null"))',
    ...options.writePaths.map((target) => {
      const operator =
        existsSync(target) && !lstatSync(target).isDirectory()
          ? 'literal'
          : 'subpath';
      return `(allow file-write* (${operator} ${sandboxQuote(target)}))`;
    }),
    ...(options.gitDirectories ?? []).map((target) => {
      const operator =
        existsSync(target) && !lstatSync(target).isDirectory()
          ? 'literal'
          : 'subpath';
      return `(deny file-write* (${operator} ${sandboxQuote(target)}))`;
    }),
  ];
}

function sandboxProfile(options: {
  readPaths: string[];
  writePaths: string[];
  scratch: string;
  gitDirectories?: string[];
  denyReadPaths?: string[];
}): string {
  return [
    '(version 1)',
    '(allow default)',
    ...readBoundaryRules(
      [...options.readPaths, options.scratch],
      options.denyReadPaths,
    ),
    ...writeBoundaryRules(options),
    '(deny network*)',
    '(deny signal)',
    '',
  ].join('\n');
}

function hostGitProfile(options: {
  readPaths: string[];
  writePaths: string[];
  scratch: string;
  gitDirectories?: string[];
}): string {
  return [
    '(version 1)',
    '(allow default)',
    ...homeReadBoundaryRules([...options.readPaths, options.scratch]),
    ...writeBoundaryRules(options),
    '(deny network*)',
    '(deny signal)',
    '',
  ].join('\n');
}

function git(
  cwd: string,
  args: string[],
  input?: Buffer,
  options: { writePaths?: string[]; denyGitMetadata?: boolean } = {},
): Buffer {
  const scratch = path.join(shellRoot(), 'git-scratch', randomUUID());
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const profile = hostGitProfile({
    readPaths: [cwd],
    writePaths: options.writePaths ?? [],
    scratch,
    gitDirectories: options.denyGitMetadata ? [path.join(cwd, '.git')] : [],
  });
  const result = spawnSync(
    '/usr/bin/sandbox-exec',
    [
      '-p',
      profile,
      GIT_BINARY,
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      cwd,
      ...args,
    ],
    {
      input,
      encoding: null,
      maxBuffer: MAX_GIT_OUTPUT,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: scratch,
        TMPDIR: scratch,
        LANG: 'C.UTF-8',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/usr/bin/false',
        GIT_SSH_COMMAND: '/usr/bin/false',
      },
    },
  );
  rmSync(scratch, { recursive: true, force: true });
  if (result.status !== 0)
    throw new Error(
      Buffer.from(result.stderr).toString('utf8').trim() ||
        result.error?.message ||
        `git ${args[0]} failed (status ${String(result.status)}, signal ${String(result.signal)})`,
    );
  const stdout = Buffer.from(result.stdout);
  if (stdout.length > MAX_GIT_OUTPUT)
    throw new Error('Git output exceeded the transactional shell limit');
  return stdout;
}

async function runProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const collect = (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      const remaining = MAX_OUTPUT - bytes;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const terminateGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The process group already exited.
      }
    };
    const abort = () => terminateGroup('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      options.signal?.removeEventListener('abort', abort);
      terminateGroup('SIGTERM');
      setTimeout(() => {
        terminateGroup('SIGKILL');
        const suffix = truncated
          ? '\n\n[Output truncated at 1 MiB.]'
          : signal
            ? `\n\n[Terminated by ${signal}.]`
            : '';
        resolve({
          output: `${Buffer.concat(chunks).toString('utf8')}${suffix}`,
          exitCode: code ?? 1,
        });
      }, 100);
    });
  });
}

function copyUntracked(repositoryRoot: string, transactionRoot: string): void {
  const names = git(repositoryRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  for (const relative of names) {
    const source = path.join(repositoryRoot, relative);
    const target = path.join(transactionRoot, relative);
    if (!isInside(repositoryRoot, source) || !isInside(transactionRoot, target))
      throw new Error('Untracked snapshot path escaped its repository');
    if (
      lstatSync(source).isSymbolicLink() &&
      !isInside(repositoryRoot, realpathSync(source))
    )
      throw new Error(
        `Dependency root escapes the repository and cannot be cloned safely: ${source}`,
      );
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
}

function validateSnapshotSymlinks(transactionRoot: string): void {
  const queue = [transactionRoot];
  while (queue.length > 0) {
    const directory = queue.shift() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = realpathSync(target);
        } catch {
          throw new Error(`Snapshot contains a dangling symlink: ${target}`);
        }
        if (!isInside(transactionRoot, resolved))
          throw new Error(
            `Snapshot symlink escapes the transaction: ${target}`,
          );
      }
    }
  }
}

function cloneDependencies(
  repositoryRoot: string,
  transactionRoot: string,
): void {
  const packageFiles = git(repositoryRoot, [
    'ls-files',
    '-z',
    '--',
    'package.json',
    '*/package.json',
    '**/package.json',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const directories = new Set([
    '',
    ...packageFiles
      .map((file) => path.dirname(file))
      .filter((item) => item !== '.'),
  ]);
  for (const directory of [...directories].slice(0, 100)) {
    const source = path.join(repositoryRoot, directory, 'node_modules');
    const target = path.join(transactionRoot, directory, 'node_modules');
    if (!existsSync(source) || existsSync(target)) continue;
    const resolved = realpathSync(source);
    if (!isInside(repositoryRoot, resolved))
      throw new Error(
        `Dependency root escapes the repository and cannot be cloned safely: ${source}`,
      );
    mkdirSync(path.dirname(target), { recursive: true });
    const cloned = spawnSync('/bin/cp', ['-cR', resolved, target], {
      encoding: null,
    });
    if (cloned.status !== 0)
      throw new Error(
        Buffer.from(cloned.stderr).toString('utf8').trim() ||
          `Could not create an APFS dependency clone for ${source}`,
      );
  }
}

function materializeTransaction(
  repositoryRoot: string,
  directory: string,
): string {
  const transactionRoot = path.join(directory, 'repository');
  const archive = path.join(directory, 'base.tar');
  mkdirSync(transactionRoot, { recursive: true });
  git(
    repositoryRoot,
    ['archive', '--format=tar', '-o', archive, 'HEAD'],
    undefined,
    { writePaths: [directory] },
  );
  const extracted = spawnSync(
    '/usr/bin/tar',
    ['-xf', archive, '-C', transactionRoot],
    { encoding: null },
  );
  if (extracted.status !== 0)
    throw new Error(
      Buffer.from(extracted.stderr).toString('utf8').trim() ||
        'Could not extract repository snapshot',
    );
  unlinkSync(archive);
  const dirty = git(repositoryRoot, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--full-index',
    'HEAD',
  ]);
  if (dirty.length > 0)
    git(
      transactionRoot,
      ['apply', '--binary', '--whitespace=nowarn', '-'],
      dirty,
      { writePaths: [transactionRoot] },
    );
  copyUntracked(repositoryRoot, transactionRoot);
  validateSnapshotSymlinks(transactionRoot);
  const transactionWrite = { writePaths: [transactionRoot] };
  git(transactionRoot, ['init', '-q'], undefined, transactionWrite);
  git(
    transactionRoot,
    ['config', 'user.name', 'Pi Autonomy Transaction'],
    undefined,
    transactionWrite,
  );
  git(
    transactionRoot,
    ['config', 'user.email', 'autonomy-transaction@invalid'],
    undefined,
    transactionWrite,
  );
  git(transactionRoot, ['add', '-A', '-f'], undefined, transactionWrite);
  git(
    transactionRoot,
    ['commit', '-qm', 'snapshot'],
    undefined,
    transactionWrite,
  );
  cloneDependencies(repositoryRoot, transactionRoot);
  return transactionRoot;
}

function gitMetadataFingerprint(repositoryRoot: string): string {
  const hash = createHash('sha256');
  hash.update(git(repositoryRoot, ['rev-parse', 'HEAD']));
  hash.update(
    git(repositoryRoot, [
      'diff',
      '--cached',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--full-index',
      'HEAD',
      '--',
    ]),
  );
  return hash.digest('hex');
}

function manifestFingerprint(repositoryRoot: string): string {
  const hash = createHash('sha256');
  const files = git(repositoryRoot, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ])
    .toString('utf8')
    .split('\0')
    .filter(
      (relative) => relative && existsSync(path.join(repositoryRoot, relative)),
    )
    .sort();
  for (const relative of files) {
    const target = path.join(repositoryRoot, relative);
    const stat = lstatSync(target);
    hash.update(relative);
    hash.update(`${stat.mode}:${stat.size}`);
    if (stat.isSymbolicLink()) hash.update(readlinkSync(target));
    else if (stat.isFile()) hash.update(readFileSync(target));
  }
  return hash.digest('hex');
}

function fingerprint(repositoryRoot: string): string {
  const hash = createHash('sha256');
  hash.update(git(repositoryRoot, ['rev-parse', 'HEAD']));
  hash.update(
    git(repositoryRoot, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--full-index',
      'HEAD',
    ]),
  );
  const untracked = git(repositoryRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const relative of untracked) {
    const target = path.join(repositoryRoot, relative);
    hash.update(relative);
    const stat = lstatSync(target);
    hash.update(`${stat.mode}:${stat.size}`);
    if (stat.isSymbolicLink()) hash.update(readlinkSync(target));
    else if (stat.isFile()) hash.update(readFileSync(target));
  }
  return hash.digest('hex');
}

function freezeTransaction(transactionRoot: string): {
  paths: string[];
  destructivePaths: string[];
  patch: Buffer;
} {
  git(transactionRoot, ['add', '-A', '--'], undefined, {
    writePaths: [transactionRoot],
  });
  const base = [
    'diff',
    '--cached',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
  ];
  const paths = git(transactionRoot, [
    ...base,
    '--name-only',
    '-z',
    'HEAD',
    '--',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  const destructivePaths = git(transactionRoot, [
    ...base,
    '--diff-filter=DT',
    '--name-only',
    '-z',
    'HEAD',
    '--',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const patch = git(transactionRoot, [
    ...base,
    '--binary',
    '--full-index',
    'HEAD',
    '--',
  ]);
  return { paths, destructivePaths, patch };
}

function acquireLock(repositoryRoot: string, directory: string): () => void {
  const key = createHash('sha256').update(repositoryRoot).digest('hex');
  const lockRoot = path.join(shellRoot(), 'locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(lockRoot, `${key}.lock`);
  const contents = `${JSON.stringify({ pid: process.pid, directory })}\n`;
  try {
    writeFileSync(lock, contents, { flag: 'wx', mode: 0o600 });
  } catch {
    let active = false;
    try {
      const owner = JSON.parse(readFileSync(lock, 'utf8')) as {
        pid?: unknown;
      };
      active = processAlive(owner.pid);
    } catch {
      active = true;
    }
    if (active)
      throw new Error('Another sandbox shell is applying a repository patch');
    rmSync(lock, { force: true });
    writeFileSync(lock, contents, { flag: 'wx', mode: 0o600 });
  }
  return () => rmSync(lock, { force: true });
}

async function executeSandbox(options: {
  profilePath: string;
  cwd: string;
  command: string;
  scratch: string;
  signal?: AbortSignal;
}): Promise<{ output: string; exitCode: number }> {
  return runProcess({
    command: '/usr/bin/sandbox-exec',
    args: ['-f', options.profilePath, '/bin/bash', '-lc', options.command],
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: options.scratch,
      TMPDIR: options.scratch,
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      CI: '1',
      NO_COLOR: '1',
    },
    signal: options.signal,
  });
}

export async function runSandboxShell(options: {
  envelope: CapabilityEnvelope;
  cwd: string;
  command: string;
  mode: SandboxShellMode;
  scope?: string[];
  signal?: AbortSignal;
}): Promise<SandboxShellResult> {
  if (!sandboxBackendAvailable())
    throw new Error('macOS sandbox-exec is unavailable');
  const shellCwd = canonicalPath(options.cwd, '.');
  const directory = path.join(shellRoot(), 'runs', randomUUID());
  const scratch = path.join(directory, 'scratch');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(directory, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
    { mode: 0o600 },
  );
  const profilePath = path.join(directory, 'profile.sb');
  try {
    if (options.mode === 'inspect') {
      const readPaths = options.envelope.repositories.flatMap(
        (authority) => authority.scopes.inspect ?? [],
      );
      const nestedBoundaries = options.envelope.repositories.map((authority) =>
        nestedRepositoryBoundary(options.envelope, authority.root),
      );
      if (nestedBoundaries.some((boundary) => !boundary.complete))
        throw new Error(
          'Nested repository discovery was incomplete; inspect shell was blocked.',
        );
      const denyReadPaths = nestedBoundaries.flatMap(
        (boundary) => boundary.unauthorized,
      );
      writeFileSync(
        profilePath,
        sandboxProfile({
          readPaths,
          writePaths: [],
          scratch,
          denyReadPaths,
        }),
        { mode: 0o600 },
      );
      const result = await executeSandbox({
        profilePath,
        cwd: shellCwd,
        command: options.command,
        scratch,
        signal: options.signal,
      });
      return {
        mode: options.mode,
        backend: 'macos-sandbox-exec',
        ...result,
        changedPaths: [],
        applied: false,
      };
    }

    const repositoryRoot = repositoryRootForPath(shellCwd);
    const nestedBoundary = nestedRepositoryBoundary(
      options.envelope,
      repositoryRoot,
    );
    if (!nestedBoundary.complete || nestedBoundary.unauthorized.length > 0)
      throw new Error(
        'Transactional shell execution requires independent inspect leases for every nested repository.',
      );
    const baselineFingerprint = fingerprint(repositoryRoot);
    const transactionRoot = materializeTransaction(repositoryRoot, directory);
    const relativeCwd = path.relative(repositoryRoot, shellCwd);
    const transactionCwd = path.join(transactionRoot, relativeCwd);
    const gitDirectory = path.join(transactionRoot, '.git');
    writeFileSync(
      profilePath,
      sandboxProfile({
        readPaths: [transactionRoot],
        writePaths: [transactionRoot],
        scratch,
        gitDirectories: [gitDirectory],
      }),
      { mode: 0o600 },
    );
    const result = await executeSandbox({
      profilePath,
      cwd: transactionCwd,
      command: options.command,
      scratch,
      signal: options.signal,
    });
    const frozen = freezeTransaction(transactionRoot);
    const { paths, patch } = frozen;
    const patchSha256 = createHash('sha256').update(patch).digest('hex');
    if (
      options.mode === 'validate' ||
      paths.length === 0 ||
      result.exitCode !== 0
    )
      return {
        mode: options.mode,
        backend: 'macos-sandbox-exec',
        ...result,
        changedPaths: paths,
        applied: false,
        ...(paths.length > 0 ? { patchSha256 } : {}),
      };

    const scopes = (options.scope ?? []).map((entry) =>
      canonicalPath(shellCwd, entry),
    );
    const outside = paths.find((relative) => {
      const target = canonicalPath(repositoryRoot, relative);
      return !scopes.some((scope) => isInside(scope, target));
    });
    if (outside)
      return {
        mode: options.mode,
        backend: 'macos-sandbox-exec',
        ...result,
        changedPaths: paths,
        applied: false,
        patchSha256,
        rejection: `out-of-scope:${outside}`,
      };
    if (frozen.destructivePaths.length > 0)
      return {
        mode: options.mode,
        backend: 'macos-sandbox-exec',
        ...result,
        changedPaths: paths,
        applied: false,
        patchSha256,
        rejection: `destructive-change:${frozen.destructivePaths.join(',')}`,
      };
    const release = acquireLock(repositoryRoot, directory);
    let metadataBeforeApply = '';
    try {
      if (fingerprint(repositoryRoot) !== baselineFingerprint)
        return {
          mode: options.mode,
          backend: 'macos-sandbox-exec',
          ...result,
          changedPaths: paths,
          applied: false,
          patchSha256,
          rejection: 'parent-drift',
        };
      metadataBeforeApply = gitMetadataFingerprint(repositoryRoot);
      git(repositoryRoot, ['apply', '--check', '--binary', '-'], patch);
      git(repositoryRoot, ['apply', '--binary', '-'], patch, {
        writePaths: [repositoryRoot],
        denyGitMetadata: true,
      });
    } finally {
      release();
    }
    const postApplyDrift =
      metadataBeforeApply !== gitMetadataFingerprint(repositoryRoot) ||
      manifestFingerprint(repositoryRoot) !==
        manifestFingerprint(transactionRoot);
    return {
      mode: options.mode,
      backend: 'macos-sandbox-exec',
      ...result,
      changedPaths: paths,
      applied: true,
      patchSha256,
      ...(postApplyDrift ? { conflicted: true } : {}),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function registerSandboxShell(
  pi: ExtensionAPI,
  getEnvelope: () => CapabilityEnvelope,
  onResult?: (result: SandboxShellResult) => void,
): void {
  pi.registerTool({
    name: 'sandbox_shell',
    label: 'Sandbox Shell',
    description:
      'Run Bash syntax inside an effect-contained macOS sandbox. inspect denies repository writes; validate runs against a transactional snapshot and discards writes; edit applies only non-destructive, in-scope changes after drift and patch checks. Network, signals, credentials, and Git metadata writes are denied.',
    promptSnippet:
      'Use sandbox_shell for shell pipelines, repository checks, builds, tests, formatters, and scoped command-driven edits while capability enforcement is active',
    promptGuidelines: [
      'Use inspect for commands expected to read only. If a check or build may write caches or outputs, use validate; its transaction sees the current worktree and discards command writes.',
      'Use edit only when command-generated source changes are intended, and provide the narrowest existing scope paths. Deletions, out-of-scope changes, failed commands, or parent drift are never applied.',
      'Command classification is advisory only; the OS sandbox and transactional patch checks enforce effects.',
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
      mode: StringEnum(['inspect', 'validate', 'edit'] as const, {
        description:
          'Expected effect profile. inspect is read-only; validate discards writes; edit may apply safe scoped changes.',
      }),
      cwd: Type.Optional(Type.String({ maxLength: 4096 })),
      scope: Type.Optional(
        Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 100 }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await runSandboxShell({
        envelope: getEnvelope(),
        cwd: params.cwd ?? ctx.cwd,
        command: params.command,
        mode: params.mode,
        scope: params.scope,
        signal,
      });
      onResult?.(result);
      const status = [
        `mode=${result.mode}`,
        `exit=${result.exitCode}`,
        `applied=${result.applied}`,
        result.changedPaths.length > 0
          ? `changed=${result.changedPaths.join(',')}`
          : 'changed=none',
        ...(result.patchSha256 ? [`patch=${result.patchSha256}`] : []),
        ...(result.rejection ? [`rejection=${result.rejection}`] : []),
        ...(result.conflicted ? ['conflicted=true'] : []),
      ].join(' ');
      return {
        content: [
          {
            type: 'text' as const,
            text: `${result.output || '(command completed with no output)'}\n\n[${status}]`,
          },
        ],
        details: result,
      };
    },
  });
}
