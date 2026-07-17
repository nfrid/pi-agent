import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { sandboxBackendAvailable } from '../delegate/isolation';
import { createRun } from '../delegate/types';
import { applySnapshot, initialState } from '../tasks/state';
import { parseAutonomyConfig, resolveProfile } from './config';
import {
  collectWorkflowDiagnostics,
  formatWorkflowDiagnostics,
} from './doctor';
import { confirmEnvelopeChange } from './index';
import { MetricsCollector } from './metrics';
import { generateNavigation } from './navigation';
import {
  createEnvelope,
  decideCapabilityAction,
  decideToolCall,
  diffEnvelopes,
  isAuthorityExpansion,
  mergeProposal,
} from './policy';
import {
  boundedBudget,
  findDependencyCycles,
  runReadyTaskScheduler,
  runSequentialTaskControl,
} from './scheduler';
import { discoverTrustedRepositoryRoots, isTrustedRepository } from './scope';
import { runSandboxShell } from './shell';
import { HARD_AUTONOMY_DEFAULTS } from './types';

const roots: string[] = [];
function temporary(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  applySnapshot(initialState());
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function repository(root = temporary('autonomy-repo')): string {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Test']);
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'tests'));
  writeFileSync(
    path.join(root, 'src', 'thing.ts'),
    "import { helper } from './helper';\nexport const thing = helper;\n",
  );
  writeFileSync(
    path.join(root, 'src', 'helper.ts'),
    'export const helper = 1;\n',
  );
  writeFileSync(path.join(root, 'tests', 'thing.test.ts'), 'thing\n');
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'vitest', lint: 'biome check .' } }),
  );
  writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

describe('capability policy and profiles', () => {
  test('keeps capabilities independent and blocks shell under enforcement', () => {
    const root = repository();
    const inspect = createEnvelope({
      repositoryRoot: root,
      paths: ['src'],
      capabilities: ['inspect'],
      source: 'cli',
    });
    expect(
      decideToolCall(
        { toolName: 'edit', input: { path: 'src/thing.ts' } } as never,
        inspect,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'missing-capability' });
    const edit = createEnvelope({
      repositoryRoot: root,
      paths: ['src'],
      capabilities: ['inspect', 'edit'],
      source: 'cli',
    });
    expect(
      decideToolCall(
        { toolName: 'write', input: { path: 'tests/out.ts' } } as never,
        edit,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'outside-scope' });
    expect(
      decideToolCall(
        { toolName: 'bash', input: { command: 'true' } } as never,
        edit,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'uncontrolled-shell' });
  });

  test('requires independent authority for Git metadata and nested repositories', () => {
    const root = repository();
    const nested = repository(
      path.join(root, 'ordinary', 'deep', 'nested-product'),
    );
    const envelope = createEnvelope({
      repositoryRoot: root,
      capabilities: ['inspect', 'edit'],
      source: 'cli',
    });
    expect(
      decideToolCall(
        { toolName: 'write', input: { path: '.git/config' } } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'missing-capability' });
    expect(
      decideToolCall(
        { toolName: 'write', input: { path: 'src/thing.ts' } } as never,
        envelope,
        nested,
      ),
    ).toMatchObject({ allowed: false, code: 'outside-scope' });
    expect(
      decideToolCall(
        { toolName: 'grep', input: { pattern: 'thing', path: root } } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'unsupported-tool' });
    expect(
      decideToolCall(
        {
          toolName: 'delegate',
          input: { task: 'inspect all', cwd: root },
        } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'unsupported-tool' });
    expect(
      decideToolCall(
        {
          toolName: 'sandbox_shell',
          input: { mode: 'validate', cwd: root, command: 'true' },
        } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'unsupported-tool' });
    const narrow = mergeProposal(envelope, {
      capabilities: ['inspect'],
      paths: [path.join(nested, 'src')],
      rationale: 'narrow nested inspection',
    });
    expect(
      decideToolCall(
        {
          toolName: 'sandbox_shell',
          input: { mode: 'validate', cwd: root, command: 'true' },
        } as never,
        narrow,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'unsupported-tool' });
    const leased = mergeProposal(envelope, {
      capabilities: ['edit'],
      paths: [nested],
      rationale: 'explicit nested repository work',
    });
    expect(
      decideToolCall(
        { toolName: 'write', input: { path: 'src/thing.ts' } } as never,
        leased,
        nested,
      ),
    ).toMatchObject({ allowed: true });
    expect(
      decideToolCall(
        {
          toolName: 'delegate',
          input: { task: 'inspect all', cwd: root },
        } as never,
        leased,
        root,
      ),
    ).toMatchObject({ allowed: true });
  });

  test('blocks delegate working directories outside inspect authority', () => {
    const root = repository();
    const envelope = createEnvelope({
      repositoryRoot: root,
      capabilities: ['inspect'],
      source: 'cli',
    });
    expect(
      decideToolCall(
        {
          toolName: 'delegate',
          input: { task: 'inspect elsewhere', cwd: temporary('outside') },
        } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'outside-scope' });
    expect(
      decideToolCall(
        {
          toolName: 'delegate',
          input: { task: 'inspect nested', cwd: 'src' },
        } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: true });
  });

  test('requires explicit or resolvable scope for writable delegates', () => {
    const root = repository();
    const envelope = createEnvelope({
      repositoryRoot: root,
      capabilities: ['inspect', 'edit'],
      source: 'cli',
    });
    expect(
      decideToolCall(
        {
          toolName: 'delegate',
          input: { task: 'write', allowWrites: true },
        } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'write-scope-required' });
    expect(
      decideToolCall(
        {
          toolName: 'delegate',
          input: {
            task: 'continue',
            continuation: 'opaque',
            allowWrites: true,
          },
        } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'invalid-target' });
    expect(
      decideToolCall(
        {
          toolName: 'delegate',
          input: {
            allowWrites: true,
            tasks: [{ task: 'inspect', allowWrites: false }],
          },
        } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: true });
  });

  test('blocks implicit-path and unknown tools outside supported policy', () => {
    const root = repository();
    const envelope = createEnvelope({
      repositoryRoot: root,
      paths: ['src'],
      capabilities: ['inspect'],
      source: 'cli',
    });
    expect(
      decideToolCall(
        { toolName: 'grep', input: { pattern: 'thing' } } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'outside-scope' });
    expect(
      decideToolCall(
        { toolName: 'unknown_mutator', input: {} } as never,
        envelope,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'unsupported-tool' });
  });

  test('profiles cannot grant hard capabilities or automatic application', () => {
    expect(HARD_AUTONOMY_DEFAULTS).toEqual({
      localGit: false,
      delivery: false,
      destructive: false,
      automaticPatchApply: false,
    });
    expect(
      parseAutonomyConfig({
        profile: 'high',
        capabilities: ['edit', 'bogus'],
      }),
    ).toMatchObject({ profile: 'high', capabilities: ['edit'] });
    expect(resolveProfile('cautiuos').name).toBe('cautious');
    expect(parseAutonomyConfig({ profile: 'typo' }).profile).toBe('cautious');
    expect(
      parseAutonomyConfig({
        mode: 'canary',
        trustedRoots: ['/workspace'],
        autoApprove: ['inspect', 'edit', 'deliver'],
      }),
    ).toMatchObject({
      mode: 'canary',
      trustedRoots: ['/workspace'],
      autoApprove: ['inspect', 'edit'],
    });
  });

  test('computes semantic scope deltas and additive proposals', () => {
    const root = repository();
    const current = createEnvelope({
      repositoryRoot: root,
      paths: ['src'],
      capabilities: ['inspect'],
      source: 'cli',
    });
    const narrowed = createEnvelope({
      repositoryRoot: root,
      paths: ['src/nested'],
      capabilities: ['inspect'],
      source: 'user-command',
    });
    expect(isAuthorityExpansion(diffEnvelopes(current, narrowed))).toBe(false);
    const expanded = mergeProposal(current, {
      capabilities: ['edit'],
      paths: ['.'],
      rationale: 'implementation',
    });
    const delta = diffEnvelopes(current, expanded);
    expect(delta.addedCapabilities).toEqual(['edit']);
    expect(delta.expandedPaths).toEqual([realpathSync(root)]);
    expect(isAuthorityExpansion(delta)).toBe(true);
    expect(Object.keys(expanded.repositories[0].scopes)).toEqual([
      'inspect',
      'edit',
    ]);
    expect(
      expanded.repositories[0].scopes.inspect?.some((entry) =>
        entry.endsWith('/src'),
      ),
    ).toBe(true);
  });

  test('keeps inspect and edit paths independent inside one repository', () => {
    const root = repository();
    const current = createEnvelope({
      repositoryRoot: root,
      capabilities: ['inspect'],
      source: 'cli',
    });
    const proposed = mergeProposal(current, {
      capabilities: ['edit'],
      paths: ['src/helper.ts'],
      rationale: 'focused implementation',
    });
    const authority = proposed.repositories[0];
    expect(authority.scopes.inspect).toContain(realpathSync(root));
    expect(authority.scopes.edit).toEqual([
      realpathSync(path.join(root, 'src', 'helper.ts')),
    ]);
    expect(
      decideToolCall(
        { toolName: 'write', input: { path: 'tests/out.ts' } } as never,
        proposed,
        root,
      ),
    ).toMatchObject({ allowed: false, code: 'outside-scope' });
  });

  test('auto-approves repository-aware canary leases inside trusted roots', async () => {
    const workspace = temporary('autonomy-workspace');
    const metadata = repository(path.join(workspace, 'metadata'));
    const product = repository(path.join(workspace, 'product'));
    const current = createEnvelope({
      repositoryRoot: metadata,
      capabilities: ['inspect'],
      source: 'cli',
    });
    const proposed = mergeProposal(current, {
      capabilities: ['edit'],
      paths: [product],
      rationale: 'cross-repository implementation',
    });
    const delta = diffEnvelopes(current, proposed);
    expect(delta.addedRepositories).toEqual([realpathSync(product)]);
    expect(proposed.repositories).toHaveLength(2);
    await expect(
      confirmEnvelopeChange(
        { hasUI: false } as never,
        current,
        proposed,
        resolveProfile('standard'),
        'fixture',
        {
          mode: 'canary',
          trustedRoots: [workspace],
          autoApprove: ['inspect', 'edit'],
        },
      ),
    ).resolves.toBe(true);
    expect(
      decideToolCall(
        { toolName: 'write', input: { path: 'src/new.ts' } } as never,
        proposed,
        product,
      ),
    ).toMatchObject({ allowed: true });
  });

  test('discovers independent repositories inside a trusted metadata workspace', () => {
    const workspace = temporary('trusted-workspace');
    const metadata = repository(path.join(workspace, 'metadata'));
    const product = repository(path.join(workspace, 'product'));
    writeFileSync(
      path.join(workspace, 'mg.config.json'),
      JSON.stringify({ repos: [{ name: 'product', path: product }] }),
    );
    const discovered = discoverTrustedRepositoryRoots([workspace]);
    expect(discovered).toContain(realpathSync(metadata));
    expect(discovered).toContain(realpathSync(product));
    expect(isTrustedRepository(product, [workspace])).toBe(true);
  });

  test('does not auto-approve excluded capabilities, untrusted roots, or TTL expansion', async () => {
    const root = repository();
    const current = createEnvelope({
      repositoryRoot: root,
      paths: ['src'],
      capabilities: ['inspect', 'edit'],
      source: 'cli',
      ttlMs: 60_000,
      now: 1,
    });
    const pathExpansion = mergeProposal(
      current,
      {
        capabilities: ['edit'],
        paths: ['tests'],
        rationale: 'expand edit scope',
      },
      2,
    );
    const contexts = { hasUI: false } as never;
    await expect(
      confirmEnvelopeChange(
        contexts,
        current,
        pathExpansion,
        resolveProfile('standard'),
        'fixture',
        {
          mode: 'canary',
          trustedRoots: [root],
          autoApprove: ['inspect'],
        },
      ),
    ).resolves.toBe(false);
    await expect(
      confirmEnvelopeChange(
        contexts,
        current,
        pathExpansion,
        resolveProfile('standard'),
        'fixture',
        {
          mode: 'canary',
          trustedRoots: [temporary('other-trust-root')],
          autoApprove: ['inspect', 'edit'],
        },
      ),
    ).resolves.toBe(false);
    const ttlExpansion = mergeProposal(
      current,
      {
        capabilities: ['inspect'],
        paths: ['src'],
        rationale: 'extend lease',
        ttlMs: 120_000,
      },
      2,
    );
    await expect(
      confirmEnvelopeChange(
        contexts,
        current,
        ttlExpansion,
        resolveProfile('standard'),
        'fixture',
        {
          mode: 'canary',
          trustedRoots: [root],
          autoApprove: ['inspect', 'edit'],
        },
      ),
    ).resolves.toBe(false);
  });

  test('keeps hard capability actions independent and confirmed', () => {
    const root = repository();
    const localGit = createEnvelope({
      repositoryRoot: root,
      capabilities: ['inspect', 'local-git'],
      source: 'cli',
    });
    expect(
      decideCapabilityAction('deliver', localGit, resolveProfile('high'), true),
    ).toMatchObject({ allowed: false, code: 'missing-capability' });
    expect(
      decideCapabilityAction('local-git', localGit, resolveProfile('cautious')),
    ).toMatchObject({ allowed: false, code: 'confirmation-required' });
    expect(
      decideCapabilityAction('local-git', localGit, resolveProfile('standard')),
    ).toMatchObject({ allowed: true });
    const deliver = createEnvelope({
      repositoryRoot: root,
      capabilities: ['deliver'],
      source: 'cli',
    });
    expect(
      decideCapabilityAction('deliver', deliver, resolveProfile('high')),
    ).toMatchObject({ allowed: false, code: 'confirmation-required' });
    const destructive = createEnvelope({
      repositoryRoot: root,
      capabilities: ['destructive'],
      source: 'cli',
    });
    expect(
      decideCapabilityAction(
        'destructive',
        destructive,
        resolveProfile('high'),
      ),
    ).toMatchObject({ allowed: false, code: 'confirmation-required' });
  });

  test('fails closed when an envelope expansion has no interactive UI', async () => {
    const root = repository();
    const current = createEnvelope({
      repositoryRoot: root,
      paths: ['src'],
      capabilities: ['inspect'],
      source: 'cli',
    });
    const proposed = mergeProposal(current, {
      capabilities: ['edit'],
      paths: ['.'],
      rationale: 'fixture',
    });
    await expect(
      confirmEnvelopeChange(
        { hasUI: false } as never,
        current,
        proposed,
        resolveProfile('standard'),
        'fixture',
      ),
    ).resolves.toBe(false);
  });
});

describe.skipIf(!sandboxBackendAvailable())(
  'effect-contained parent shell',
  () => {
    test('denies inspect writes without mutating the parent', async () => {
      const root = repository();
      const envelope = createEnvelope({
        repositoryRoot: root,
        capabilities: ['inspect'],
        source: 'cli',
      });
      const before = readFileSync(path.join(root, 'src', 'thing.ts'), 'utf8');
      const result = await runSandboxShell({
        envelope,
        cwd: root,
        command: "printf 'mutated\\n' > src/thing.ts",
        mode: 'inspect',
      });
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(path.join(root, 'src', 'thing.ts'), 'utf8')).toBe(
        before,
      );
      const outside = temporary('sandbox-secret');
      writeFileSync(path.join(outside, 'secret.txt'), 'private\n');
      const readEscape = await runSandboxShell({
        envelope,
        cwd: root,
        command: `cat ${JSON.stringify(path.join(outside, 'secret.txt'))}`,
        mode: 'inspect',
      });
      expect(readEscape.exitCode).not.toBe(0);
      expect(readEscape.output).not.toContain('private');
    });

    test('denies recursive reads into nested repositories without a lease', async () => {
      const root = repository();
      const nested = repository(
        path.join(root, 'ordinary', 'deep', 'nested-product'),
      );
      const envelope = createEnvelope({
        repositoryRoot: root,
        capabilities: ['inspect'],
        source: 'cli',
      });
      const result = await runSandboxShell({
        envelope,
        cwd: root,
        command: `cat ${JSON.stringify(path.join(nested, 'src', 'helper.ts'))}`,
        mode: 'inspect',
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).not.toContain('helper = 1');
      await expect(
        runSandboxShell({
          envelope,
          cwd: root,
          command: 'true',
          mode: 'validate',
        }),
      ).rejects.toThrow(/independent inspect leases/);
      const narrow = mergeProposal(envelope, {
        capabilities: ['inspect'],
        paths: [path.join(nested, 'src')],
        rationale: 'narrow nested inspection',
      });
      await expect(
        runSandboxShell({
          envelope: narrow,
          cwd: root,
          command: 'true',
          mode: 'validate',
        }),
      ).rejects.toThrow(/independent inspect leases/);
    });

    test('validates against dirty current state and discards command writes', async () => {
      const root = repository();
      writeFileSync(
        path.join(root, 'src', 'helper.ts'),
        'export const helper = 2;\n',
      );
      const envelope = createEnvelope({
        repositoryRoot: root,
        capabilities: ['inspect'],
        source: 'cli',
      });
      const result = await runSandboxShell({
        envelope,
        cwd: root,
        command:
          "grep -q 'helper = 2' src/helper.ts && printf 'generated\\n' > generated.txt",
        mode: 'validate',
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result).toMatchObject({
        applied: false,
        changedPaths: ['generated.txt'],
      });
      expect(existsSync(path.join(root, 'generated.txt'))).toBe(false);
      expect(
        readFileSync(path.join(root, 'src', 'helper.ts'), 'utf8'),
      ).toContain('helper = 2');
    });

    test('applies safe scoped command edits and rejects deletions', async () => {
      const root = repository();
      const envelope = createEnvelope({
        repositoryRoot: root,
        capabilities: ['inspect', 'edit'],
        source: 'cli',
      });
      const applied = await runSandboxShell({
        envelope,
        cwd: root,
        command: "printf 'export const helper = 3;\\n' > src/helper.ts",
        mode: 'edit',
        scope: ['src/helper.ts'],
      });
      expect(applied).toMatchObject({
        exitCode: 0,
        applied: true,
        changedPaths: ['src/helper.ts'],
      });
      expect(
        readFileSync(path.join(root, 'src', 'helper.ts'), 'utf8'),
      ).toContain('helper = 3');
      const rejected = await runSandboxShell({
        envelope,
        cwd: root,
        command: 'rm src/helper.ts',
        mode: 'edit',
        scope: ['src/helper.ts'],
      });
      expect(rejected.applied).toBe(false);
      expect(rejected.rejection).toMatch(/destructive-change/);
      expect(existsSync(path.join(root, 'src', 'helper.ts'))).toBe(true);
    });

    test('rejects out-of-scope edits and concurrent parent drift', async () => {
      const root = repository();
      const envelope = createEnvelope({
        repositoryRoot: root,
        capabilities: ['inspect', 'edit'],
        source: 'cli',
      });
      const outside = await runSandboxShell({
        envelope,
        cwd: root,
        command: "printf 'outside\\n' > tests/out.ts",
        mode: 'edit',
        scope: ['src'],
      });
      expect(outside).toMatchObject({
        applied: false,
        rejection: 'out-of-scope:tests/out.ts',
      });
      expect(existsSync(path.join(root, 'tests', 'out.ts'))).toBe(false);

      const running = runSandboxShell({
        envelope,
        cwd: root,
        command:
          "sleep 0.4; printf 'export const helper = 4;\\n' > src/helper.ts",
        mode: 'edit',
        scope: ['src/helper.ts'],
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(path.join(root, 'AGENTS.md'), '# Concurrent change\n');
      const drifted = await running;
      expect(drifted).toMatchObject({
        applied: false,
        rejection: 'parent-drift',
      });
      expect(
        readFileSync(path.join(root, 'src', 'helper.ts'), 'utf8'),
      ).toContain('helper = 1');
    });

    test('blocks transaction symlink writes back into the parent', async () => {
      const root = repository();
      const target = path.join(root, 'src', 'helper.ts');
      symlinkSync(target, path.join(root, 'escape-link'));
      const envelope = createEnvelope({
        repositoryRoot: root,
        capabilities: ['inspect', 'edit'],
        source: 'cli',
      });
      await expect(
        runSandboxShell({
          envelope,
          cwd: root,
          command: "printf 'escaped\\n' > escape-link",
          mode: 'edit',
          scope: ['escape-link'],
        }),
      ).rejects.toThrow(/Snapshot symlink escapes/);
      expect(readFileSync(target, 'utf8')).toContain('helper = 1');
    });

    test('rejects dependency roots that escape the repository', async () => {
      const root = repository();
      const external = temporary('external-dependencies');
      symlinkSync(external, path.join(root, 'node_modules'), 'dir');
      const envelope = createEnvelope({
        repositoryRoot: root,
        capabilities: ['inspect'],
        source: 'cli',
      });
      await expect(
        runSandboxShell({
          envelope,
          cwd: root,
          command: 'true',
          mode: 'validate',
        }),
      ).rejects.toThrow(/Dependency root escapes/);
    });

    test('denies network and Git metadata effects', async () => {
      const root = repository();
      const envelope = createEnvelope({
        repositoryRoot: root,
        capabilities: ['inspect'],
        source: 'cli',
      });
      const network = await runSandboxShell({
        envelope,
        cwd: root,
        command: '/usr/bin/curl --max-time 1 -s https://example.com',
        mode: 'inspect',
      });
      expect(network.exitCode).not.toBe(0);
      const metadata = await runSandboxShell({
        envelope,
        cwd: root,
        command: 'git tag forbidden-tag',
        mode: 'validate',
      });
      expect(metadata.exitCode).not.toBe(0);
      expect(git(root, ['tag', '--list', 'forbidden-tag']).trim()).toBe('');
    });
  },
);

describe('navigation, diagnostics, metrics, and scheduler planning', () => {
  test('invalidates navigation snapshots on worktree changes and stays advisory', async () => {
    const root = repository();
    mkdirSync(path.join(root, 'mg'));
    writeFileSync(
      path.join(root, 'mg', 'mg.config.json'),
      JSON.stringify({
        repos: [
          {
            name: 'fixture',
            path: root,
            defaultBranch: 'main',
            verification: { commands: ['test'] },
          },
        ],
      }),
    );
    const first = await generateNavigation({ cwd: root, query: 'thing' });
    writeFileSync(
      path.join(root, 'src', 'thing.ts'),
      'export const thing = 2;\n',
    );
    const second = await generateNavigation({ cwd: root, query: 'thing' });
    writeFileSync(
      path.join(root, 'src', 'thing.ts'),
      'export const thing = 3;\n',
    );
    const third = await generateNavigation({ cwd: root, query: 'thing' });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(third.snapshotId).not.toBe(second.snapshotId);
    expect(second.disclaimer).toContain('Candidate locator only');
    expect(second.likelyTests).toContain('tests/thing.test.ts');
    expect(second.packageScripts).toEqual(['lint', 'test']);
    expect(second.version).toBe(2);
    expect(second.verificationRequired).toBe(true);
    expect(second.workspaceFacts).toMatchObject({
      repositoryName: 'fixture',
      verificationCommands: ['test'],
    });
    expect(
      second.symbolHints.some((hint) => hint.path.endsWith('src/thing.ts')),
    ).toBe(true);
    expect(first.importHints.some((hint) => hint.path === 'src/thing.ts')).toBe(
      true,
    );
    expect(second.liveEvidence.length).toBeGreaterThan(0);
  });

  test('parses porcelain rename records without treating the old path as status', async () => {
    const root = repository();
    git(root, ['mv', 'src/thing.ts', 'src/renamed.ts']);
    const navigation = await generateNavigation({ cwd: root });
    expect(navigation.changedPaths).toContain('src/renamed.ts');
    expect(navigation.changedPaths).not.toContain('/thing.ts');
  });

  test('reports inactive duplicate skills as warnings, not failures', () => {
    const root = repository();
    for (const directory of ['one', 'two']) {
      const skill = path.join(root, '.agents', 'skills', directory);
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        path.join(skill, 'SKILL.md'),
        '---\nname: duplicate\ndescription: fixture\n---\n',
      );
    }
    const diagnostics = collectWorkflowDiagnostics({
      cwd: root,
      systemPromptOptions: {
        cwd: root,
        skills: [
          {
            name: 'duplicate',
            filePath: path.join(root, '.agents', 'skills', 'one', 'SKILL.md'),
          },
        ],
        contextFiles: [
          {
            path: path.join(root, 'AGENTS.md'),
            content:
              '# Rules\nUse `/gone` here. Ticket is required. Ticket is forbidden.',
          },
        ],
      } as never,
      flags: {
        'context-governor': false,
        'autonomy-enforce': false,
      },
      commandNames: ['workflow-doctor'],
    });
    const duplicate = diagnostics.find(
      (item) => item.code === 'inactive-duplicate-skill',
    );
    expect(duplicate?.severity).toBe('warning');
    expect(formatWorkflowDiagnostics(diagnostics)).toContain('WARNING');
    expect(
      diagnostics.find((item) => item.code === 'active-skill-precedence')
        ?.severity,
    ).toBe('info');
    expect(
      diagnostics.find((item) => item.code === 'stale-command-reference')
        ?.severity,
    ).toBe('warning');
    expect(
      diagnostics.find((item) => item.code === 'commit-rule-conflict')
        ?.severity,
    ).toBe('warning');
  });

  test('classifies active ambiguity, missing paths, allowlist leaks, and rollback gates', () => {
    const root = repository();
    mkdirSync(path.join(root, '.agents'));
    mkdirSync(path.join(root, 'mg'));
    writeFileSync(path.join(root, 'leak.txt'), 'tracked leak\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'doctor fixture']);
    const missing = path.join(root, 'missing-skill.md');
    const diagnostics = collectWorkflowDiagnostics({
      cwd: root,
      systemPromptOptions: {
        cwd: root,
        skills: [
          { name: 'same', filePath: missing },
          { name: 'same', filePath: path.join(root, 'AGENTS.md') },
        ],
        contextFiles: [{ path: missing, content: '' }],
      } as never,
      flags: {
        'context-governor': false,
        'autonomy-enforce': false,
        'autonomy-scheduler': true,
      },
      commandNames: [],
    });
    expect(
      diagnostics.find((item) => item.code === 'active-skill-collision')
        ?.severity,
    ).toBe('ambiguity');
    expect(
      diagnostics.find((item) => item.code === 'active-skill-path-missing')
        ?.severity,
    ).toBe('error');
    expect(
      diagnostics.find((item) => item.code === 'workspace-allowlist-leak')
        ?.severity,
    ).toBe('error');
    expect(
      diagnostics.find(
        (item) => item.code === 'scheduler-provider-targets-advisory',
      )?.severity,
    ).toBe('info');
  });

  test('collects aggregate-only repeat and violation metrics', () => {
    const metrics = new MetricsCollector(1);
    metrics.toolCall('read', { path: 'secret-name' });
    metrics.toolCall('read', { path: 'secret-name' });
    metrics.policyDecision('outside-scope', false);
    metrics.policyDecision('outside-scope', true);
    expect(metrics.values.repeatedReads).toBe(1);
    expect(metrics.values.observedCapabilityViolations).toBe(1);
    expect(metrics.values.blockedCapabilityAttempts).toBe(1);
    const restored = new MetricsCollector(2, metrics.values);
    restored.toolCall('read', { path: 'secret-name' });
    expect(restored.values.repeatedReads).toBe(2);
    expect(JSON.stringify(restored.values)).not.toContain('secret-name');
    const mixed = new MetricsCollector(3, restored.values, 'canary');
    expect(mixed.values.mode).toBe('mixed');
  });

  test('bounds scheduler requests by profile hard limits', () => {
    expect(
      boundedBudget(resolveProfile('cautious'), {
        maxChildren: 99,
        maxConcurrency: 99,
        maxDurationMs: 999_999_999,
        maxTurns: 999,
        maxComputeUnits: 999,
        targetOutputTokens: 999_999,
        targetCostUsd: 999,
      }),
    ).toEqual(resolveProfile('cautious').scheduler);
  });

  test('schedules only initially ready tasks and gates dependencies on review', async () => {
    const root = repository();
    const now = Date.now();
    const fixtureTasks = [
      {
        id: 'T1',
        text: 'first',
        status: 'todo' as const,
        dependsOn: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'T2',
        text: 'dependent',
        status: 'todo' as const,
        dependsOn: ['T1'],
        createdAt: now + 1,
        updatedAt: now + 1,
      },
      {
        id: 'T3',
        text: 'independent',
        status: 'todo' as const,
        dependsOn: [],
        createdAt: now + 2,
        updatedAt: now + 2,
      },
    ];
    applySnapshot({
      version: 1,
      nextId: 4,
      tasks: fixtureTasks,
    });
    const calls: string[] = [];
    let session = 0;
    const result = await runReadyTaskScheduler({
      pi: { appendEntry() {} } as never,
      ctx: { cwd: root } as never,
      profile: resolveProfile('standard'),
      route: 'luna-low',
      requestedBudget: { maxConcurrency: 1 },
      createSessionFn: ((options: { cwd: string }) => ({
        token: `session-${++session}`,
        filePath: path.join(root, `.session-${session}`),
        cwd: options.cwd,
      })) as never,
      runDelegateFn: (async (options: {
        task: string;
        continuation?: string;
      }) => {
        calls.push(options.task);
        const run = createRun(options.task, undefined, {
          continuation: options.continuation,
        });
        run.exitCode = 0;
        run.state = 'success';
        run.messages = [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          } as never,
        ];
        return run;
      }) as never,
    });
    expect(calls).toEqual(['first', 'independent']);
    expect(result.details.selectedTaskIds).toEqual(['T1', 'T3']);
    expect(result.details.runs.every((run) => run.allowWrites !== true)).toBe(
      true,
    );
    const control = await runSequentialTaskControl({
      tasks: fixtureTasks as never,
      maxChildren: resolveProfile('standard').scheduler.maxChildren,
      execute: async (task) => {
        const run = createRun(task.text);
        run.exitCode = 0;
        run.state = 'success';
        run.messages = [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          } as never,
        ];
        return run;
      },
    });
    expect(result.details.selectedTaskIds).toEqual(control.selectedTaskIds);
    expect(result.details.runs.map((run) => run.task)).toEqual(
      control.runs.map((run) => run.task),
    );
  });

  test('enforces aggregate local turn and compute-unit admission', async () => {
    const root = repository();
    const now = Date.now();
    applySnapshot({
      version: 1,
      nextId: 4,
      tasks: ['one', 'two', 'three'].map((text, index) => ({
        id: `T${index + 1}`,
        text,
        status: 'todo' as const,
        dependsOn: [],
        createdAt: now + index,
        updatedAt: now + index,
      })),
    });
    const calls: Array<{
      task: string;
      maxTurns?: number;
      maxComputeUnits?: number;
      model?: string;
    }> = [];
    const result = await runReadyTaskScheduler({
      pi: { appendEntry() {} } as never,
      ctx: { cwd: root } as never,
      profile: resolveProfile('standard'),
      requestedBudget: {
        maxChildren: 3,
        maxConcurrency: 1,
        maxTurns: 2,
        maxComputeUnits: 8,
      },
      route: 'luna-medium',
      createSessionFn: ((options: { cwd: string }) => ({
        token: `session-${calls.length + 1}`,
        filePath: path.join(root, `.bounded-${calls.length + 1}`),
        cwd: options.cwd,
      })) as never,
      runDelegateFn: (async (options: {
        task: string;
        maxTurns?: number;
        maxComputeUnits?: number;
        routing?: { model?: string };
      }) => {
        calls.push({
          task: options.task,
          maxTurns: options.maxTurns,
          maxComputeUnits: options.maxComputeUnits,
          model: options.routing?.model,
        });
        const run = createRun(options.task, options.routing as never);
        run.exitCode = 0;
        run.state = 'success';
        run.messages = [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          } as never,
        ];
        run.usage.turns = options.maxTurns ?? 0;
        run.usage.computeUnits = options.maxComputeUnits ?? 0;
        return run;
      }) as never,
    });
    expect(calls).toEqual([
      {
        task: 'one',
        maxTurns: 1,
        maxComputeUnits: 4,
        model: 'gpt-5.6-luna',
      },
      {
        task: 'two',
        maxTurns: 1,
        maxComputeUnits: 4,
        model: 'gpt-5.6-luna',
      },
    ]);
    expect(result.details.stoppedReason).toMatch(/turn budget/);
    expect(result.details.skippedTaskIds).toEqual(['T3']);
  });

  test('treats provider output and cost as advisory stop targets', async () => {
    const root = repository();
    const now = Date.now();
    applySnapshot({
      version: 1,
      nextId: 3,
      tasks: ['one', 'two'].map((text, index) => ({
        id: `T${index + 1}`,
        text,
        status: 'todo' as const,
        dependsOn: [],
        createdAt: now + index,
        updatedAt: now + index,
      })),
    });
    const calls: string[] = [];
    const result = await runReadyTaskScheduler({
      pi: { appendEntry() {} } as never,
      ctx: { cwd: root } as never,
      profile: resolveProfile('standard'),
      route: 'luna-low',
      requestedBudget: {
        maxConcurrency: 1,
        targetOutputTokens: 1_000,
        targetCostUsd: 0.01,
      },
      createSessionFn: ((options: { cwd: string }) => ({
        token: 'target-session',
        filePath: path.join(root, '.target-session'),
        cwd: options.cwd,
      })) as never,
      runDelegateFn: (async (options: { task: string }) => {
        calls.push(options.task);
        const run = createRun(options.task);
        run.exitCode = 0;
        run.state = 'success';
        run.messages = [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          } as never,
        ];
        run.usage.output = 1_200;
        run.usage.cost = 0.02;
        return run;
      }) as never,
    });
    expect(calls).toEqual(['one']);
    expect(result.details.stoppedReason).toMatch(/advisory output-token/);
    expect(result.details.targetOvershoot).toEqual({
      outputTokens: 200,
      costUsd: 0.01,
    });
  });

  test('applies one absolute duration deadline to running scheduler children', async () => {
    const root = repository();
    const now = Date.now();
    applySnapshot({
      version: 1,
      nextId: 2,
      tasks: [
        {
          id: 'T1',
          text: 'wait',
          status: 'todo',
          dependsOn: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const started = Date.now();
    const result = await runReadyTaskScheduler({
      pi: { appendEntry() {} } as never,
      ctx: { cwd: root } as never,
      profile: resolveProfile('standard'),
      route: 'luna-low',
      requestedBudget: { maxDurationMs: 100 },
      createSessionFn: ((options: { cwd: string }) => ({
        token: 'deadline-session',
        filePath: path.join(root, '.deadline-session'),
        cwd: options.cwd,
      })) as never,
      runDelegateFn: (async (options: {
        task: string;
        signal?: AbortSignal;
      }) => {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else
            options.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
        const run = createRun(options.task);
        run.exitCode = 130;
        run.state = 'aborted';
        run.stopReason = 'aborted';
        return run;
      }) as never,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.details.stoppedReason).toBe('duration budget reached');
  });

  test('stops scheduler fan-out after the first failed batch', async () => {
    const root = repository();
    const now = Date.now();
    applySnapshot({
      version: 1,
      nextId: 4,
      tasks: ['one', 'two', 'three'].map((text, index) => ({
        id: `T${index + 1}`,
        text,
        status: 'todo' as const,
        dependsOn: [],
        createdAt: now + index,
        updatedAt: now + index,
      })),
    });
    const calls: string[] = [];
    const result = await runReadyTaskScheduler({
      pi: { appendEntry() {} } as never,
      ctx: { cwd: root } as never,
      profile: resolveProfile('standard'),
      route: 'luna-low',
      requestedBudget: { maxConcurrency: 1 },
      createSessionFn: ((options: { cwd: string }) => ({
        token: 'failed-session',
        filePath: path.join(root, '.failed-session'),
        cwd: options.cwd,
      })) as never,
      runDelegateFn: (async (options: { task: string }) => {
        calls.push(options.task);
        const run = createRun(options.task);
        run.exitCode = 1;
        run.state = 'error';
        run.errorMessage = 'fixture failure';
        return run;
      }) as never,
    });
    expect(calls).toEqual(['one']);
    expect(result.details.stoppedReason).toMatch(/failure/);
    expect(result.details.skippedTaskIds).toEqual(['T2', 'T3']);
  });

  test('detects todo dependency cycles before launch', () => {
    const now = Date.now();
    const tasks = [
      {
        id: 'T1',
        text: 'one',
        status: 'todo',
        dependsOn: ['T2'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'T2',
        text: 'two',
        status: 'todo',
        dependsOn: ['T1'],
        createdAt: now,
        updatedAt: now,
      },
    ] as const;
    expect(findDependencyCycles(tasks as never)).toEqual([['T1', 'T2', 'T1']]);
  });
});
