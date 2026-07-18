import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  applyIsolationPatch,
  attachIsolationSession,
  captureIsolationPatch,
  delegateStateRoot,
  discardIsolation,
  discardReadOnlySandbox,
  isolationPatchBytes,
  loadIsolation,
  prepareChildAuth,
  prepareReadOnlySandbox,
  prepareWritableIsolation,
  readOnlySandboxSpawn,
  sandboxBackendAvailable,
  scrubStaleIsolationCredentials,
} from './isolation';
import {
  agentDir,
  git,
  repository,
  root,
  sandboxRun,
  validate,
} from './test/isolation-fixture';

describe('isolation records and sandbox', () => {
  test('stores broker state outside the target agent repository by default', () => {
    const configured = process.env.PI_DELEGATE_STATE_DIR;
    delete process.env.PI_DELEGATE_STATE_DIR;
    try {
      expect(delegateStateRoot().startsWith(repository)).toBe(false);
    } finally {
      if (configured === undefined) delete process.env.PI_DELEGATE_STATE_DIR;
      else process.env.PI_DELEGATE_STATE_DIR = configured;
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
});
