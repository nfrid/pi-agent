import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import type { DelegateConfig } from './config';
import { buildDelegatePlans } from './plans';

const config: DelegateConfig = {
  timeoutMs: 60_000,
  maxParallelTasks: 2,
  maxConcurrency: 2,
  maxRelativeCost: 3,
  provider: 'openai-codex',
  modelCatalog: {
    quick: {
      model: 'gpt-test',
      thinking: 'low',
      relativeCost: 1,
      relativeIntelligence: 1,
    },
  },
};

const ctx = { cwd: '/tmp/project' } as ExtensionContext;

describe('buildDelegatePlans', () => {
  test('builds a single fresh task plan', () => {
    const built = buildDelegatePlans(
      { task: ' inspect ', route: 'quick' },
      ctx,
      config,
      () => null,
    );
    expect(built.parallel).toBe(false);
    expect(built.plans).toHaveLength(1);
    expect(built.plans[0]?.task).toBe('inspect');
    expect(built.plans[0]?.context).toBe('fresh');
    expect(built.preflights).toHaveLength(1);
  });

  test('requires a branch snapshot for branch context', () => {
    expect(() =>
      buildDelegatePlans(
        { task: 'inspect', route: 'quick', context: 'branch' },
        ctx,
        config,
        () => null,
      ),
    ).toThrow('failed to snapshot current session branch.');
  });

  test('builds parallel plans and attaches write warnings', () => {
    const built = buildDelegatePlans(
      {
        tasks: [
          { task: 'inspect', route: 'quick' },
          {
            task: 'implement',
            route: 'quick',
            allowWrites: true,
            scope: ['/tmp/project/src'],
          },
        ],
      },
      ctx,
      config,
      () => '{"messages":[]}',
    );
    expect(built.parallel).toBe(true);
    expect(built.plans).toHaveLength(2);
    expect(built.plans[1]?.writeRequested).toBe(true);
    expect(built.preflights).toHaveLength(2);
  });

  test('rejects an empty parallel task list', () => {
    expect(() =>
      buildDelegatePlans({ tasks: [{ task: '   ' }] }, ctx, config, () => null),
    ).toThrow('Parallel delegation requires a non-empty task.');
  });

  test('rejects too many parallel tasks', () => {
    expect(() =>
      buildDelegatePlans(
        {
          tasks: [
            { task: 'one', route: 'quick' },
            { task: 'two', route: 'quick' },
            { task: 'three', route: 'quick' },
          ],
        },
        ctx,
        config,
        () => null,
      ),
    ).toThrow('Too many delegated tasks (3). Maximum is 2.');
  });

  test('rejects shared continuation on parallel requests', () => {
    expect(() =>
      buildDelegatePlans(
        {
          tasks: [{ task: 'inspect', route: 'quick' }],
          continuation: 'token',
        },
        ctx,
        config,
        () => null,
      ),
    ).toThrow(
      'For parallel delegation, set continuation on each task rather than as a shared default.',
    );
  });

  test('rejects continuation field replacements on single tasks', () => {
    expect(() =>
      buildDelegatePlans(
        {
          task: 'inspect',
          continuation: 'token',
          cwd: '/other',
        },
        ctx,
        config,
        () => null,
      ),
    ).toThrow('do not provide replacements');
  });
});
