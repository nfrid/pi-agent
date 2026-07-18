import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  applyIsolationPatch,
  attachIsolationSession,
  captureIsolationPatch,
  delegateStateRoot,
  discardIsolation,
  isolationPatchBytes,
  isolationValidationCommand,
  isolationValidationScript,
  loadIsolation,
  prepareWritableIsolation,
  sandboxBackendAvailable,
  validateIsolationCommand,
  validateIsolationPatch,
} from './isolation';
import {
  agentDir,
  git,
  repository,
  root,
  sandboxRun,
  validate,
} from './test/isolation-fixture';

describe('isolation patch broker', () => {
  test.skipIf(!sandboxBackendAvailable())(
    'rejects a patch containing a symlink that escapes enforced scope',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
        dependencyMode: 'isolated',
      });
      const sessionPath = path.join(agentDir, 'child-symlink.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      symlinkSync(
        repository,
        path.join(prepared.record.worktreePath, 'src', 'bad-link'),
      );
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'success',
      });
      expect(captured.patch?.diffCheckPassed).toBe(false);
      expect(captured.patch?.unsafeReason).toMatch(/symlink patch target/);
      const validated = await validate(captured.id);
      expect(validated.validation?.status).toBe('failed');
      await expect(applyIsolationPatch(captured.id)).rejects.toThrow(/symlink/);
      await discardIsolation(captured.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'transitions linked dependencies to isolated validation for manifest patches',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['.'],
        dependencyMode: 'auto',
      });
      const sessionPath = path.join(agentDir, 'child-manifest.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      expect(
        sandboxRun(
          prepared,
          `printf bad > ${JSON.stringify(path.join(prepared.record.worktreePath, 'node_modules', 'fixture', 'index.js'))}`,
        ).status,
      ).not.toBe(0);
      expect(
        sandboxRun(
          prepared,
          `mkdir -p ${JSON.stringify(path.join(prepared.record.worktreePath, 'node_modules', '.cache'))}`,
        ).status,
      ).not.toBe(0);
      const packageFile = path.join(
        prepared.record.worktreePath,
        'package.json',
      );
      const packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) as {
        description?: string;
      };
      packageJson.description = 'changed';
      writeFileSync(packageFile, `${JSON.stringify(packageJson)}\n`);
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'success',
      });
      expect(captured.patch?.requiresIsolatedDependencyValidation).toBe(true);
      const validated = await validate(captured.id);
      expect(validated.dependencyMode).toBe('isolated');
      expect(validated.validation?.status).toBe('passed');
      const applied = await applyIsolationPatch(validated.id);
      expect(applied.status).toBe('applied');
      await discardIsolation(applied.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'keeps broker patch files outside child-writable scratch space',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      expect(result.isolation).toBeDefined();
      const prepared = result.isolation as NonNullable<typeof result.isolation>;
      const sentinel = path.join(root, 'broker-sentinel');
      writeFileSync(sentinel, 'unchanged');
      symlinkSync(
        sentinel,
        path.join(prepared.record.scratchPath, 'changes.patch'),
      );
      writeFileSync(
        path.join(prepared.record.worktreePath, 'src', 'value.txt'),
        'two\n',
      );

      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'success',
      });
      expect(captured.status).toBe('patch-ready');
      expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
      expect(isolationPatchBytes(captured)?.length).toBeGreaterThan(0);
      await discardIsolation(captured.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'propagates broker capture failures and persists failed isolation state',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      expect(result.isolation).toBeDefined();
      const prepared = result.isolation as NonNullable<typeof result.isolation>;
      const broker = path.join(
        delegateStateRoot(),
        'delegate-worktrees',
        'v1',
        prepared.record.id,
        'broker',
      );
      symlinkSync(root, broker);
      writeFileSync(
        path.join(prepared.record.worktreePath, 'src', 'value.txt'),
        'two\n',
      );

      await expect(
        captureIsolationPatch(prepared.record.id, { outcome: 'success' }),
      ).rejects.toThrow('Unsafe broker directory');
      expect(loadIsolation(prepared.record.id)?.status).toBe('failed');
      rmSync(broker);
      await discardIsolation(prepared.record.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'applies rename-like changes with consistent no-rename path verification',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
        dependencyMode: 'isolated',
      });
      expect(result.isolation).toBeDefined();
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        path.join(agentDir, 'rename-session.jsonl'),
      );
      git(prepared.record.worktreePath, [
        'mv',
        'src/value.txt',
        'src/renamed.txt',
      ]);
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'success',
      });
      expect(captured.patch?.changedPaths).toEqual([
        'src/renamed.txt',
        'src/value.txt',
      ]);
      const validated = await validate(captured.id);
      expect(validated.validation?.status).toBe('passed');
      const applied = await applyIsolationPatch(validated.id);
      expect(applied.status).toBe('applied');
      expect(existsSync(path.join(repository, 'src', 'renamed.txt'))).toBe(
        true,
      );
      await discardIsolation(applied.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'validates non-package repositories with exact command argv',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
        dependencyMode: 'isolated',
      });
      const sessionPath = path.join(agentDir, 'child-command-validation.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      writeFileSync(
        path.join(prepared.record.worktreePath, 'src', 'value.txt'),
        'delegate\n',
      );
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'success',
      });
      const argv = ['/bin/test', '-f', 'src/value.txt'];
      const confirmed = isolationValidationCommand(captured.id, argv);
      const validated = await validateIsolationCommand(
        captured.id,
        argv,
        confirmed.sha256,
      );
      expect(validated.validation?.status).toBe('passed');
      const signalArgv = ['/bin/kill', '-0', String(process.pid)];
      const signalConfirmation = isolationValidationCommand(
        validated.id,
        signalArgv,
      );
      const denied = await validateIsolationCommand(
        validated.id,
        signalArgv,
        signalConfirmation.sha256,
      );
      expect(denied.validation?.status).toBe('failed');
      await discardIsolation(denied.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'binds controlled validation to the exact confirmed script hash',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['.'],
      });
      const sessionPath = path.join(agentDir, 'child-script-race.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      writeFileSync(
        path.join(prepared.record.worktreePath, 'src', 'value.txt'),
        'delegate\n',
      );
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'success',
      });
      const confirmed = isolationValidationScript(captured.id, 'check');
      const packageFile = path.join(
        prepared.record.worktreePath,
        'package.json',
      );
      const packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) as {
        scripts: Record<string, string>;
      };
      packageJson.scripts.check = 'node -e "process.exit(1)"';
      writeFileSync(packageFile, `${JSON.stringify(packageJson)}\n`);
      await expect(
        validateIsolationPatch(captured.id, 'check', confirmed.sha256),
      ).rejects.toThrow(/changed after confirmation/);
      await discardIsolation(captured.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'rejects parent changes after validation under the patch broker gate',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-stale.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      writeFileSync(
        path.join(prepared.record.worktreePath, 'src', 'value.txt'),
        'delegate\n',
      );
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'success',
      });
      const validated = await validate(captured.id);
      expect(validated.validation?.status).toBe('passed');
      writeFileSync(path.join(repository, 'src', 'value.txt'), 'parent\n');
      await expect(applyIsolationPatch(validated.id)).rejects.toThrow(
        /Parent repository changed/,
      );
      git(repository, ['reset', '--hard', '-q', 'HEAD']);
      await discardIsolation(validated.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'leaves parent bytes unchanged when git rejects an application',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-atomic.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      writeFileSync(
        path.join(prepared.record.worktreePath, 'src', 'value.txt'),
        'delegate\n',
      );
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'success',
      });
      const validated = await validate(captured.id);
      const parentFile = path.join(repository, 'src', 'value.txt');
      writeFileSync(parentFile, 'hidden-parent-change\n');
      git(repository, ['update-index', '--assume-unchanged', 'src/value.txt']);
      const before = readFileSync(parentFile);
      await expect(applyIsolationPatch(validated.id)).rejects.toThrow(
        /patch-check-failed/,
      );
      expect(readFileSync(parentFile)).toEqual(before);
      git(repository, [
        'update-index',
        '--no-assume-unchanged',
        'src/value.txt',
      ]);
      git(repository, ['reset', '--hard', '-q', 'HEAD']);
      await discardIsolation(validated.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'keeps patches from failed delegate runs ineligible',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-failed.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      writeFileSync(
        path.join(prepared.record.worktreePath, 'src', 'value.txt'),
        'partial\n',
      );
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'error',
      });
      expect(captured.status).toBe('failed');
      expect(() => validate(captured.id)).toThrow(/not ready|outcome/);
      await expect(applyIsolationPatch(captured.id)).rejects.toThrow(
        /not ready/,
      );
      await discardIsolation(captured.id);
    },
  );
});
