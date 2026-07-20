import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { brokerPath, replaceBrokerFile } from './broker-fs';
import { isolationEnvironment } from './kernel';
import { withIsolationLock } from './locks';
import type { IsolationRecord } from './model';
import { captureIsolationPatchUnlocked } from './patch-capture-unlocked';
import { loadIsolation, writeIsolationRecord } from './records';
import { sandboxProfile } from './sandbox';

const execFileAsync = promisify(execFile);
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

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
