import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import * as path from 'node:path';
import { brokerPath, readBrokerFile, replaceBrokerFile } from './broker-fs';
import { git } from './kernel';
import { withIsolationLock, withRepositoryLock } from './locks';
import type {
  IsolationRecord,
  PatchEligibility,
  PatchEligibilityCode,
} from './model';
import { isolationPatchBytes } from './patch-capture';
import { loadIsolation, writeIsolationRecord } from './records';

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
