import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  applyIsolationPatch,
  attachIsolationSession,
  captureIsolationPatch,
  delegateStateRoot,
  discardIsolation,
  discardReadOnlySandbox,
  isolationPatchBytes,
  isolationSpawn,
  isolationValidationCommand,
  isolationValidationScript,
  loadIsolation,
  markIsolationRunning,
  prepareChildAuth,
  prepareReadOnlySandbox,
  prepareWritableIsolation,
  readOnlySandboxSpawn,
  sandboxBackendAvailable,
  scrubStaleIsolationCredentials,
  validateIsolationCommand,
  validateIsolationPatch,
} from './isolation';
import { runDelegate } from './runner';
import { getRunState } from './types';

let root: string;
let agentDir: string;
let repository: string;

function git(cwd: string, args: string[]): string {
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
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_DELEGATE_STATE_DIR;
  delete process.env.PI_ISOLATION_TEST_SECRET;
  rmSync(root, { recursive: true, force: true });
});

function validate(id: string) {
  const script = isolationValidationScript(id, 'check');
  return validateIsolationPatch(id, 'check', script.sha256);
}

function sandboxRun(
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

describe('writable delegate isolation', () => {
  test('stores broker state outside the target agent repository by default', () => {
    const configured = process.env.PI_DELEGATE_STATE_DIR;
    delete process.env.PI_DELEGATE_STATE_DIR;
    try {
      expect(delegateStateRoot().startsWith(repository)).toBe(false);
    } finally {
      if (configured) process.env.PI_DELEGATE_STATE_DIR = configured;
    }
  });

  test('rejects malformed or mis-rooted records before cleanup uses their paths', () => {
    const id = randomUUID();
    const directory = path.join(
      delegateStateRoot(),
      'delegate-worktrees',
      'v1',
      id,
    );
    const external = path.join(root, 'external-scratch');
    mkdirSync(path.join(external, 'agent'), { recursive: true });
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'record.json'),
      JSON.stringify({ version: 1, id, scratchPath: external }),
    );

    expect(loadIsolation(id)).toBeUndefined();
    expect(() => scrubStaleIsolationCredentials()).not.toThrow();
    expect(existsSync(path.join(external, 'agent'))).toBe(true);
  });

  test.skipIf(!sandboxBackendAvailable())(
    'keeps Bash available in an enforceable read-only sandbox',
    () => {
      const sessionPath = path.join(agentDir, 'read-only-session.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const sandbox = prepareReadOnlySandbox(repository, sessionPath);
      expect(sandbox).toBeDefined();
      expect(
        existsSync(
          path.join(String(sandbox?.env.PI_CODING_AGENT_DIR), 'auth.json'),
        ),
      ).toBe(true);
      try {
        const inspect = readOnlySandboxSpawn(sandbox as never, '/bin/sh', [
          '-c',
          'grep -q one src/value.txt',
        ]);
        expect(
          spawnSync(inspect.command, inspect.args, {
            cwd: inspect.cwd,
            env: { ...process.env, ...inspect.env },
          }).status,
        ).toBe(0);
        const strictShell = (script: string) =>
          spawnSync(
            '/usr/bin/sandbox-exec',
            [
              '-f',
              (sandbox as NonNullable<typeof sandbox>).shellProfilePath,
              '/bin/sh',
              '-c',
              script,
            ],
            {
              cwd: repository,
              env: {
                PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                HOME: (sandbox as NonNullable<typeof sandbox>).directory,
              },
              encoding: 'utf8',
            },
          );
        expect(strictShell('grep -q one src/value.txt').status).toBe(0);
        expect(strictShell('printf changed > src/value.txt').status).not.toBe(
          0,
        );
        expect(
          strictShell('env | grep -q PI_ISOLATION_TEST_SECRET').status,
        ).not.toBe(0);
        expect(strictShell('kill -0 $PPID').status).not.toBe(0);
        const hostCredential = path.join(
          homedir(),
          '.pi',
          'agent',
          'auth.json',
        );
        if (existsSync(hostCredential))
          expect(strictShell(`/bin/cat ${hostCredential}`).status).not.toBe(0);
        expect(
          strictShell(
            `/usr/bin/python3 -c 'import errno,socket; s=socket.socket();\ntry: s.connect(("127.0.0.1",9))\nexcept OSError as e: raise SystemExit(0 if e.errno == errno.EPERM else 2)\nraise SystemExit(3)'`,
          ).status,
        ).toBe(0);
        expect(
          readFileSync(path.join(repository, 'src', 'value.txt'), 'utf8'),
        ).toBe('one\n');
      } finally {
        discardReadOnlySandbox(sandbox);
      }
    },
  );

  test('scrubs stale read-only credential directories after owner loss', () => {
    const auth = prepareChildAuth();
    expect(
      existsSync(path.join(String(auth.env.PI_CODING_AGENT_DIR), 'auth.json')),
    ).toBe(true);
    writeFileSync(
      path.join(auth.directory, 'owner.json'),
      '{"pid":99999999,"identity":"stale"}\n',
    );
    expect(scrubStaleIsolationCredentials()).toBe(1);
    expect(existsSync(auth.directory)).toBe(false);
  });

  test.skipIf(!sandboxBackendAvailable())(
    'scrubs credential snapshots left by a stale prepared isolation',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'stale-auth-session.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      expect(
        existsSync(
          path.join(prepared.record.scratchPath, 'agent', 'auth.json'),
        ),
      ).toBe(true);
      expect(scrubStaleIsolationCredentials()).toBe(1);
      expect(existsSync(path.join(prepared.record.scratchPath, 'agent'))).toBe(
        false,
      );
      await discardIsolation(prepared.record.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'enforces scope, parent, dependency, and symlink boundaries and applies a verified patch',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
        dependencyMode: 'auto',
      });
      expect(result.fallbackReason).toBeUndefined();
      expect(result.isolation?.record.dependencyMode).toBe('link');
      const sessionPath = path.join(agentDir, 'child.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      const worktree = prepared.record.worktreePath;
      const sibling = path.join(root, 'sibling-repository');
      mkdirSync(sibling);
      const parentSentinel = path.join(repository, 'parent.txt');
      writeFileSync(parentSentinel, 'protected\n');
      git(repository, ['add', 'parent.txt']);
      git(repository, ['commit', '-qm', 'sentinel']);
      // The parent HEAD change is intentional for the escape probe; restore exact
      // base before patch application.
      git(repository, ['reset', '--hard', '-q', prepared.record.baseHead]);

      expect(
        sandboxRun(
          prepared,
          `printf changed > ${JSON.stringify(path.join(worktree, 'src', 'value.txt'))}`,
        ).status,
      ).toBe(0);
      expect(
        sandboxRun(
          prepared,
          `printf bad > ${JSON.stringify(path.join(worktree, 'other', 'bad.txt'))}`,
        ).status,
      ).not.toBe(0);
      expect(
        sandboxRun(
          prepared,
          `printf bad > ${JSON.stringify(path.join(repository, 'bad.txt'))}`,
        ).status,
      ).not.toBe(0);
      expect(
        sandboxRun(
          prepared,
          `printf bad > ${JSON.stringify(path.join(sibling, 'bad.txt'))}`,
        ).status,
      ).not.toBe(0);
      expect(
        sandboxRun(
          prepared,
          `printf bad > ${JSON.stringify(path.join(worktree, 'node_modules', 'fixture', 'index.js'))}`,
        ).status,
      ).not.toBe(0);
      symlinkSync(repository, path.join(worktree, 'src', 'escape'));
      expect(
        sandboxRun(
          prepared,
          `printf bad > ${JSON.stringify(path.join(worktree, 'src', 'escape', 'escaped.txt'))}`,
        ).status,
      ).not.toBe(0);
      rmSync(path.join(worktree, 'src', 'escape'));

      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'success',
      });
      expect(captured.status).toBe('patch-ready');
      expect(captured.patch?.changedPaths).toEqual(['src/value.txt']);
      expect(isolationPatchBytes(captured)?.length).toBeGreaterThan(0);
      const validated = await validate(captured.id);
      expect(validated.validation?.status).toBe('passed');
      const applied = await applyIsolationPatch(captured.id);
      expect(applied.status).toBe('applied');
      expect(
        readFileSync(path.join(repository, 'src', 'value.txt'), 'utf8'),
      ).toBe('changed');
      await discardIsolation(captured.id);
      await discardIsolation(captured.id);
      expect(existsSync(worktree)).toBe(false);
    },
  );

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

  test.skipIf(!sandboxBackendAvailable())(
    'refuses to discard an active child worktree',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-running.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      await markIsolationRunning(prepared.record.id);
      await expect(discardIsolation(prepared.record.id)).rejects.toThrow(
        /child is running/,
      );
      await captureIsolationPatch(prepared.record.id, { outcome: 'error' });
      await discardIsolation(prepared.record.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'recovers and discards a stale running worktree owner',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-stale-owner.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      await markIsolationRunning(prepared.record.id);
      const recordPath = path.join(
        agentDir,
        'state',
        'delegate-worktrees',
        'v1',
        prepared.record.id,
        'record.json',
      );
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
        runOwner: { pid: number; identity: string; startedAt: string };
      };
      record.runOwner = {
        pid: 999_999,
        identity: 'definitely-not-live',
        startedAt: new Date(0).toISOString(),
      };
      writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
      await discardIsolation(prepared.record.id);
      expect(existsSync(prepared.record.worktreePath)).toBe(false);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'isolates a nested workspace cwd at the containing repository root',
    async () => {
      const nested = path.join(repository, 'packages', 'app');
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(nested, 'value.txt'), 'nested\n');
      git(repository, ['add', '.']);
      git(repository, ['commit', '-qm', 'nested workspace fixture']);
      const result = await prepareWritableIsolation({
        cwd: nested,
        scopes: ['.'],
      });
      expect(result.isolation?.record.repositoryRoot).toBe(repository);
      expect(result.isolation?.record.workingDirectory).toBe('packages/app');
      expect(result.isolation?.record.requestedScopes).toEqual([
        'packages/app',
      ]);
      expect(result.isolation?.record.writablePaths[0]).toMatch(
        /packages\/app$/,
      );
      const spawn = isolationSpawn(
        result.isolation as NonNullable<typeof result.isolation>,
        '/bin/pwd',
        [],
      );
      expect(spawn.cwd).toBe(
        path.join(
          result.isolation?.record.worktreePath as string,
          'packages/app',
        ),
      );
      await discardIsolation(result.isolation?.record.id as string);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'captures aborted child lifecycle and permits explicit cleanup',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-aborted.jsonl');
      writeFileSync(sessionPath, '{}\n');
      const prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      await markIsolationRunning(prepared.record.id);
      const captured = await captureIsolationPatch(prepared.record.id, {
        outcome: 'aborted',
      });
      expect(captured.status).toBe('failed');
      expect(captured.runOwner).toBeUndefined();
      await discardIsolation(captured.id);
    },
  );

  test.skipIf(!sandboxBackendAvailable())(
    'terminates an actual isolated child on abort and retains a cleanable failed record',
    async () => {
      const result = await prepareWritableIsolation({
        cwd: repository,
        scopes: ['src'],
      });
      const sessionPath = path.join(agentDir, 'child-real-abort.jsonl');
      writeFileSync(sessionPath, '{}\n');
      let prepared = attachIsolationSession(
        result.isolation as NonNullable<typeof result.isolation>,
        randomUUID(),
        sessionPath,
      );
      prepared = {
        ...prepared,
        record: await markIsolationRunning(prepared.record.id),
      };
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      const fakePi = path.join(bin, 'pi');
      writeFileSync(
        fakePi,
        '#!/bin/sh\ntest -f "$PI_CODING_AGENT_DIR/auth.json" || exit 42\ntest -z "$PI_ISOLATION_TEST_SECRET" || exit 43\nsleep 30\n',
      );
      chmodSync(fakePi, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}:${previousPath ?? ''}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const run = await runDelegate({
          cwd: prepared.record.worktreePath,
          task: 'abort fixture',
          context: 'fresh',
          sessionPath,
          allowWrites: true,
          writeRequested: true,
          isolation: prepared,
          timeoutMs: 10_000,
          killGraceMs: 100,
          maxConcurrency: 1,
          signal: controller.signal,
          makeDetails: (runs) => ({ mode: 'single', runs }),
        });
        expect(getRunState(run)).toBe('aborted');
        expect(
          existsSync(path.join(prepared.record.scratchPath, 'agent')),
        ).toBe(false);
        const captured = await captureIsolationPatch(prepared.record.id, {
          outcome: 'aborted',
        });
        expect(captured.status).toBe('failed');
        expect(captured.runOwner).toBeUndefined();
        await discardIsolation(captured.id);
      } finally {
        clearTimeout(timer);
        process.env.PATH = previousPath;
      }
    },
  );

  test('falls back to read-only for dirty and untracked repositories', async () => {
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'dirty\n');
    writeFileSync(path.join(repository, 'untracked.txt'), 'user work\n');
    const result = await prepareWritableIsolation({
      cwd: repository,
      scopes: ['src'],
    });
    expect(result.isolation).toBeUndefined();
    expect(result.fallbackReason).toMatch(/dirty/);
  });

  test('rejects scopes escaping through symlinks', async () => {
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(repository, 'escape'));
    git(repository, ['add', 'escape']);
    git(repository, ['commit', '-qm', 'tracked escape fixture']);
    const result = await prepareWritableIsolation({
      cwd: repository,
      scopes: ['escape'],
    });
    expect(result.isolation).toBeUndefined();
    expect(result.fallbackReason).toMatch(/scope escapes/);
  });
});
