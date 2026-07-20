import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
  assertRegularBrokerFile,
  brokerPath,
  replaceBrokerFile,
} from './broker-fs';
import { MANIFEST_NAMES } from './constants';
import { git, isInside } from './kernel';
import type { IsolationRecord } from './model';
import { loadIsolation, writeIsolationRecord } from './records';

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

export async function captureIsolationPatchUnlocked(
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
