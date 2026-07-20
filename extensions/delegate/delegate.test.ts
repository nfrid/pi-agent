import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { buildSystemPrompt } from '../system-prompt';
import {
  describeDelegateRouting,
  parseDelegateConfig,
  resolveDelegateRoute,
} from './config';
import {
  assertDistinctContinuationTokens,
  throwIfAllRunsFailed,
} from './param-errors';
import { buildDelegatePrompt } from './prompt';
import { formatDelegateRoutingConfig } from './routing';
import { mergeDelegateRouteRequest } from './routing-warnings';
import {
  buildChildArgs,
  mapWithConcurrency,
  resolvePiSpawn,
  runDelegate,
} from './runner';
import {
  buildSessionSnapshotJsonl,
  createDelegateSession,
  DELEGATE_SESSION_MAX_AGE_MS,
  pruneDelegateSessions,
  resolveDelegateSession,
  updateDelegateSessionRouting,
} from './session';
import { delegatePromptGuidelines } from './tool';
import { delegateToolBoundary } from './tool-boundary';
import { createRun, getFinalAssistantText, getRunState } from './types';

const assistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
};

describe('delegate', () => {
  test('throws only when every completed delegate run failed', () => {
    const failed = createRun('failed');
    failed.exitCode = 1;
    failed.state = 'error';
    failed.errorMessage = 'boom';
    expect(() => throwIfAllRunsFailed([failed], 'all failed')).toThrow(
      'all failed',
    );

    const success = createRun('success');
    success.exitCode = 0;
    success.state = 'success';
    success.messages = [assistantMessage as never];
    expect(() =>
      throwIfAllRunsFailed([success, failed], 'must not throw'),
    ).not.toThrow();
  });

  test('rejects duplicate parallel continuation ownership', () => {
    expect(() =>
      assertDistinctContinuationTokens(['session-a', undefined, 'session-a']),
    ).toThrow('Each parallel task must use a distinct continuation token.');
    expect(() =>
      assertDistinctContinuationTokens(['session-a', undefined, 'session-b']),
    ).not.toThrow();
  });

  test('drains started workers and stops scheduling after a worker fails', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    let settled = false;
    const mapped = mapWithConcurrency([0, 1, 2], 2, async (_item, index) => {
      started.push(index);
      if (index === 0) await first;
      if (index === 1) throw new Error('worker failed');
      return index;
    });
    void mapped.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(settled).toBe(false);

    releaseFirst();
    await expect(mapped).rejects.toThrow('worker failed');
    expect(started).toEqual([0, 1]);
  });

  test('defaults children to read-only work without a rigid report format', () => {
    const prompt = buildDelegatePrompt('Inspect the repository');
    expect(prompt).toContain('coding subagent');
    expect(prompt).toMatch(/read-only task/);
    expect(prompt).not.toMatch(/Use this exact structure/);
  });

  test('adds curated context, advisory scope, and continuation framing', () => {
    const prompt = buildDelegatePrompt('Recheck the failure', {
      contextNote: 'The parser path is already ruled out.',
      scope: ['src/cache', 'tests/cache'],
      continuation: true,
    });
    expect(prompt).toContain('Context from the parent agent');
    expect(prompt).toContain('parser path is already ruled out');
    expect(prompt).toContain('guidance, not a hard boundary');
    expect(prompt).toContain('follow-up feedback');
  });

  test('resolves exact catalog route keys within the cost ceiling', () => {
    const config = parseDelegateConfig({
      provider: 'openai-codex',
      maxRelativeCost: 3,
      modelCatalog: {
        precise: {
          provider: 'custom-provider',
          model: 'precise-model',
          thinking: 'high',
          relativeCost: 1.5,
          relativeIntelligence: 3.5,
        },
        forbidden: {
          model: 'expensive',
          thinking: 'high',
          relativeCost: 4,
          relativeIntelligence: 5,
        },
      },
    });
    expect(resolveDelegateRoute('precise', config)).toEqual({
      routing: {
        route: 'precise',
        provider: 'custom-provider',
        model: 'precise-model',
        thinking: 'high',
        relativeCost: 1.5,
        relativeIntelligence: 3.5,
      },
    });
    expect(resolveDelegateRoute('missing', config).error).toMatch(
      /not in user-owned/,
    );
    expect(resolveDelegateRoute(undefined, config).error).toMatch(
      /requires a route key/,
    );
    expect(resolveDelegateRoute('forbidden', config).error).toMatch(
      /exceeds user-owned maximum/,
    );
  });

  test('requires strict catalog-only configuration and positive metrics', () => {
    expect(parseDelegateConfig({ defaultEffort: 'economy' }).error).toMatch(
      /defaultEffort is not supported/,
    );
    expect(
      parseDelegateConfig({
        modelCatalog: {
          incomplete: { model: 'x', thinking: 'low', relativeCost: 1 },
        },
      }).error,
    ).toMatch(/relativeIntelligence must be a finite number/);
    expect(
      parseDelegateConfig({
        modelCatalog: {
          invalid: {
            model: 'x',
            thinking: ['low'],
            relativeCost: 1,
            relativeIntelligence: 2,
          },
        },
      }).error,
    ).toMatch(/thinking must be one of: off, minimal/);
    expect(
      parseDelegateConfig({
        modelCatalog: {
          strict: {
            model: 'x',
            thinking: 'low',
            relativeCost: 1,
            relativeIntelligence: 2,
            extra: true,
          },
        },
      }).error,
    ).toMatch(/extra is not supported/);
    expect(
      parseDelegateConfig({
        modelCatalog: {
          route: {
            model: 'one',
            thinking: 'low',
            relativeCost: 1,
            relativeIntelligence: 2,
          },
          ' route ': {
            model: 'two',
            thinking: 'high',
            relativeCost: 2,
            relativeIntelligence: 3,
          },
        },
      }).error,
    ).toMatch(/route labels must remain unique/);
    expect(
      parseDelegateConfig({
        modelCatalog: {
          one: {
            model: 'same',
            thinking: 'low',
            relativeCost: 1,
            relativeIntelligence: 2,
          },
          two: {
            model: 'same',
            thinking: 'low',
            relativeCost: 2,
            relativeIntelligence: 3,
          },
        },
      }).error,
    ).toMatch(/same model\/thinking pair/);
  });

  test('continuations reuse their persisted route unless overridden', () => {
    const persisted = {
      route: 'original',
      provider: 'provider',
      model: 'model',
      thinking: 'high' as const,
      relativeCost: 1,
      relativeIntelligence: 2,
    };
    expect(mergeDelegateRouteRequest(undefined, persisted)).toBe('original');
    expect(mergeDelegateRouteRequest('replacement', persisted)).toBe(
      'replacement',
    );
  });

  test('describes only explicit catalog routes', () => {
    const config = parseDelegateConfig({
      provider: 'openai-codex',
      modelCatalog: {
        quick: {
          model: 'quick',
          thinking: 'high',
          relativeCost: 1,
          relativeIntelligence: 3,
        },
        custom: {
          model: 'custom',
          thinking: 'low',
          relativeCost: 2,
          relativeIntelligence: 4,
        },
      },
    });
    expect(describeDelegateRouting(config).catalog).toEqual([
      expect.objectContaining({ route: 'quick', model: 'quick' }),
      expect.objectContaining({ route: 'custom', model: 'custom' }),
    ]);
  });

  test('snapshots the branch before the current delegate call and overrides cwd', () => {
    expect(
      buildSessionSnapshotJsonl(
        {
          getHeader: () => ({ type: 'session', id: 'abc', cwd: '/old' }),
          getBranch: () => [
            { type: 'message', id: 'one' },
            {
              type: 'message',
              id: 'current',
              message: {
                role: 'assistant',
                content: [{ type: 'toolCall', id: 'call-1' }],
              },
            },
          ],
        },
        { cwd: '/new', excludeToolCallId: 'call-1' },
      ),
    ).toBe(
      '{"type":"session","id":"abc","cwd":"/new"}\n{"type":"message","id":"one"}\n',
    );
  });

  test('creates durable opaque sessions with revalidatable resource routing', () => {
    const session = createDelegateSession({
      cwd: '/tmp/project',
      routing: {
        route: 'quick-high',
        provider: 'openai-codex',
        model: 'quick',
        thinking: 'high',
        relativeCost: 1,
        relativeIntelligence: 1,
      },
    });
    try {
      expect(resolveDelegateSession(session.token)).toEqual(session);
      const updatedRouting = {
        ...session.routing,
        route: 'quick-low',
        thinking: 'low' as const,
      } as NonNullable<typeof session.routing>;
      expect(
        updateDelegateSessionRouting(session.token, updatedRouting),
      ).toMatchObject({ routing: updatedRouting });
      expect(resolveDelegateSession(session.token)).toMatchObject({
        routing: updatedRouting,
      });
      const header = JSON.parse(
        readFileSync(session.filePath, 'utf8').trim(),
      ) as Record<string, unknown>;
      expect(header).toMatchObject({
        type: 'session',
        id: session.token,
        cwd: '/tmp/project',
      });
      expect(resolveDelegateSession('../../not-a-token')).toBeNull();
    } finally {
      const dir = path.join(getAgentDir(), '.delegate-sessions');
      rmSync(path.join(dir, `${session.token}.jsonl`), { force: true });
      rmSync(path.join(dir, `${session.token}.json`), { force: true });
    }
  });

  test('prunes aged unlinked transcripts but retains isolation-linked evidence', () => {
    const unlinked = createDelegateSession({ cwd: '/tmp/project' });
    const linked = createDelegateSession({
      cwd: '/tmp/project',
      isolationId: 'iso-retained',
    });
    const dir = path.join(getAgentDir(), '.delegate-sessions');
    const old = new Date(Date.now() - DELEGATE_SESSION_MAX_AGE_MS - 1);
    for (const session of [unlinked, linked]) {
      utimesSync(session.filePath, old, old);
      utimesSync(path.join(dir, `${session.token}.json`), old, old);
    }
    try {
      const result = pruneDelegateSessions({
        isIsolationRetained: (id) => id === 'iso-retained',
      });
      expect(result.removed).toBeGreaterThanOrEqual(1);
      expect(resolveDelegateSession(unlinked.token)).toBeNull();
      expect(resolveDelegateSession(linked.token)).toEqual(linked);
    } finally {
      for (const session of [unlinked, linked]) {
        rmSync(session.filePath, { force: true });
        rmSync(path.join(dir, `${session.token}.json`), { force: true });
      }
    }
  });

  test('resolves delegate children through PATH instead of a stale parent script', () => {
    expect(resolvePiSpawn()).toEqual({ command: 'pi', prefixArgs: [] });
  });

  test('uses persistent, minimal, read-only children with the system prompt extension', () => {
    const args = buildChildArgs({ task: 'inspect' }, '/tmp/child.jsonl');
    expect(args).toContain('--session');
    expect(args[args.indexOf('--session') + 1]).toBe('/tmp/child.jsonl');
    expect(args).toContain('--no-extensions');
    const extensionPaths = args.flatMap((arg, index) =>
      arg === '--extension' ? [args[index + 1]] : [],
    );
    expect(extensionPaths[0]).toMatch(/extensions[\\/]delegate[\\/]index\.ts$/);
    expect(extensionPaths[1]).toMatch(
      /extensions[\\/]system-prompt[\\/]index\.ts$/,
    );
    expect(extensionPaths.every(existsSync)).toBe(true);
    expect(args[args.indexOf('--tools') + 1]).toBe('read,grep,find,ls');
    const sandboxed = buildChildArgs(
      { task: 'inspect', readOnlyBash: true },
      '/tmp/child.jsonl',
    );
    expect(sandboxed[sandboxed.indexOf('--tools') + 1]).toBe(
      'read,inspect_shell,grep,find,ls',
    );
  });

  test('keeps delegate framing out of the canonical system prompt', () => {
    const options = {
      cwd: '/tmp/project',
      selectedTools: ['read'],
      toolSnippets: { read: 'Read files' },
    } as never;
    expect(buildSystemPrompt(options, 'tui')).toContain('coding agent in pi');
    expect(
      buildSystemPrompt(
        {
          cwd: '/tmp/project',
          customPrompt: 'A carefully customized prompt',
        } as never,
        'json',
      ),
    ).not.toContain('A carefully customized prompt');
    expect(buildDelegatePrompt('Inspect')).toContain(
      'coding subagent reporting to a parent agent',
    );
  });

  test('publishes the current route catalog through delegate tool guidance', () => {
    const guidelines = delegatePromptGuidelines('/tmp/project').join('\n');
    expect(guidelines).toContain('Delegate route catalog:');
    expect(guidelines).toContain('<delegate_routing>');
    expect(guidelines).toContain('luna-low: model=gpt-5.6-luna');
  });

  test('owns delegate routing prompt formatting', () => {
    const prompt = formatDelegateRoutingConfig(
      parseDelegateConfig({
        provider: 'provider',
        maxRelativeCost: 2,
        modelCatalog: {
          'quick-low': {
            model: 'quick',
            thinking: 'low',
            relativeCost: 1,
            relativeIntelligence: 2,
          },
          'smart-high': {
            model: 'smart',
            thinking: 'high',
            relativeCost: 3,
            relativeIntelligence: 8,
          },
        },
      }),
    );
    expect(prompt).toContain('quick-low: model=quick');
    expect(prompt).toContain('smart-high: model=smart');
    expect(prompt).toContain(
      'unavailable: relativeCost exceeds maxRelativeCost',
    );
  });

  test('blocks child tool paths and symlinks outside the checkout', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'delegate-boundary-'));
    const root = path.join(parent, 'repository');
    const outside = path.join(parent, 'outside.txt');
    try {
      mkdirSync(root);
      writeFileSync(path.join(root, 'inside.txt'), 'inside\n');
      writeFileSync(outside, 'outside\n');
      symlinkSync(outside, path.join(root, 'escape.txt'));
      expect(
        delegateToolBoundary('read', { path: 'inside.txt' }, root),
      ).toBeUndefined();
      expect(
        delegateToolBoundary('read', { path: '../outside.txt' }, root),
      ).toMatch(/outside/);
      expect(
        delegateToolBoundary('read', { path: 'escape.txt' }, root),
      ).toMatch(/outside/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('passes the effective explicit model and thinking to child Pi', () => {
    const args = buildChildArgs(
      {
        task: 'inspect',
        routing: {
          route: 'exact-low',
          provider: 'openai-codex',
          model: 'exact-model',
          thinking: 'low',
          relativeCost: 2,
          relativeIntelligence: 3,
        },
      },
      '/tmp/child.jsonl',
    );
    expect(
      args.slice(args.indexOf('--provider'), args.indexOf('--thinking') + 2),
    ).toEqual([
      '--provider',
      'openai-codex',
      '--model',
      'exact-model',
      '--thinking',
      'low',
    ]);
  });

  test('emits controlled mutation tools only with an isolation proof', () => {
    const blocked = buildChildArgs(
      { task: 'implement', allowWrites: true },
      '/tmp/child.jsonl',
    );
    expect(blocked[blocked.indexOf('--tools') + 1]).not.toContain('write');
    const isolated = buildChildArgs(
      {
        task: 'implement',
        allowWrites: true,
        isolation: { record: {}, profilePath: '', env: {} } as never,
      },
      '/tmp/child.jsonl',
    );
    expect(isolated[isolated.indexOf('--tools') + 1]).toContain('write');
    expect(isolated[isolated.indexOf('--tools') + 1]).not.toContain('bash');
  });

  test('blocks direct writable runner calls without isolation', async () => {
    const previousState = process.env.PI_DELEGATE_STATE_DIR;
    const state = `/tmp/delegate-no-leak-${process.pid}-${Date.now()}`;
    process.env.PI_DELEGATE_STATE_DIR = state;
    try {
      const run = await runDelegate({
        cwd: '/tmp',
        task: 'unsafe direct write',
        context: 'fresh',
        sessionPath: '/tmp/unused.jsonl',
        allowWrites: true,
        timeoutMs: 10_000,
        maxConcurrency: 1,
        mode: 'single',
      });
      expect(run.state).toBe('error');
      expect(run.errorMessage).toMatch(/isolation proof/);
      expect(existsSync(state)).toBe(false);
    } finally {
      if (previousState === undefined) delete process.env.PI_DELEGATE_STATE_DIR;
      else process.env.PI_DELEGATE_STATE_DIR = previousState;
    }
  });

  test('joins all text blocks in the final assistant response', () => {
    expect(
      getFinalAssistantText([
        {
          ...assistantMessage,
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        } as never,
      ]),
    ).toBe('first\nsecond');
  });

  test('tracks effective scope and lifecycle state', () => {
    const run = createRun('inspect', undefined, {
      cwd: '/tmp/project',
      context: 'branch',
      allowWrites: true,
    });
    expect(run).toMatchObject({
      state: 'queued',
      cwd: '/tmp/project',
      context: 'branch',
      allowWrites: true,
    });
    expect(getRunState(run)).toBe('queued');
    expect(getRunState({ ...run, state: undefined, exitCode: 124 })).toBe(
      'timed-out',
    );
  });
});
