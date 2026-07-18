import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { git, isInside, isolationEnvironment } from './kernel';
import {
  processIdentity,
  withIsolationLock,
  withRepositoryLock,
} from './locks';
import type {
  IsolationRecord,
  PatchEligibility,
  PatchEligibilityCode,
} from './model';
import {
  delegateStateRoot,
  isolationRecordDir,
  isolationRootDir,
  loadIsolation,
  writeIsolationRecord,
} from './records';
import { sandboxProfile } from './sandbox';

const execFileAsync = promisify(execFile);
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const _SAFE_ID = /^[0-9a-f-]{36}$/;
const READ_ONLY_ROOT = 'delegate-readonly/v1';
const MANIFEST_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

function _readOnlyRootDir(): string {
  return path.join(delegateStateRoot(), READ_ONLY_ROOT);
}

function brokerPath(record: IsolationRecord, basename: string): string {
  if (path.basename(basename) !== basename)
    throw new Error('Invalid broker file name');
  const directory = path.join(isolationRecordDir(record.id), 'broker');
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe broker directory');
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return path.join(directory, basename);
}

function assertRegularBrokerFile(target: string): void {
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Unsafe broker file: ${path.basename(target)}`);
}

function replaceBrokerFile(target: string, bytes: string | Buffer): void {
  if (existsSync(target)) {
    assertRegularBrokerFile(target);
    rmSync(target);
  }
  writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
}

function readBrokerFile(target: string): Buffer {
  assertRegularBrokerFile(target);
  return readFileSync(target);
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
  let indexPath: string | undefined;
  try {
    indexPath = brokerPath(record, 'patch.index');
    const patchPath = brokerPath(record, 'changes.patch');
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    if (existsSync(indexPath)) {
      assertRegularBrokerFile(indexPath);
      rmSync(indexPath);
    }
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
        [
          'diff',
          '--cached',
          '--name-only',
          '-z',
          '--no-renames',
          record.baseHead,
        ],
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
    replaceBrokerFile(patchPath, patch);
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
    writeIsolationRecord(record);
    return record;
  } catch (error) {
    record.runOwner = undefined;
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    writeIsolationRecord(record);
    throw error;
  } finally {
    if (indexPath) rmSync(indexPath, { force: true });
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
  const patchPath = brokerPath(record, 'changes.patch');
  if (!record.patch) return;
  if (!existsSync(patchPath)) {
    // One-time compatibility migration for records captured before broker files
    // moved out of child-writable scratch space.
    const legacyPath = path.join(record.scratchPath, 'changes.patch');
    try {
      const legacy = readBrokerFile(legacyPath);
      if (
        createHash('sha256').update(legacy).digest('hex') !==
        record.patch.sha256
      )
        return;
      replaceBrokerFile(patchPath, legacy);
    } catch {
      return;
    }
  }
  let bytes: Buffer;
  try {
    bytes = readBrokerFile(patchPath);
  } catch {
    return;
  }
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
  const profilePath = brokerPath(record, 'validation.sb');
  const validationRecord = {
    ...record,
    writablePaths: [record.worktreePath],
  };
  replaceBrokerFile(
    profilePath,
    sandboxProfile(validationRecord, '/dev/null', {
      denyNetwork: true,
      denySignal: true,
    }),
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
    writeIsolationRecord(record);
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
    writeIsolationRecord(record);
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
      writeIsolationRecord(record);
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
  writeIsolationRecord(record);
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
      '--no-renames',
    ]),
  );
  const paths: string[] = [];
  for (const entry of status.split('\0').filter(Boolean)) {
    const name = entry.slice(3);
    if (name) paths.push(name);
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
    const patchPath = brokerPath(record, `apply-${record.patch?.sha256}.patch`);
    if (!existsSync(patchPath)) replaceBrokerFile(patchPath, patch);
    const immutablePatch = readBrokerFile(patchPath);
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
      writeIsolationRecord(record);
      throw new Error(record.error);
    }
    record.status = 'applied';
    record.error = undefined;
    writeIsolationRecord(record);
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
    if (existsSync(path.join(isolationRootDir(), 'archive', `${id}.json`)))
      return;
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
    writeIsolationRecord(record);
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
    writeIsolationRecord(record);
    throw new Error(record.error);
  }
  record.status = 'discarded';
  const archive = path.join(isolationRootDir(), 'archive');
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(archive, `${record.id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  rmSync(isolationRecordDir(id), { recursive: true, force: true });
}

export async function discardIsolation(id: string): Promise<void> {
  return withIsolationLock(id, () => discardIsolationUnlocked(id));
}
