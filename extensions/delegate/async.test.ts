import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DelegateConfig } from './config';
import * as configModule from './config';
import delegate, { DELEGATES_COMMAND_DESCRIPTION } from './index';
import * as sessionModule from './session';
import type { PreparedDelegateTask } from './task-lifecycle';
import * as taskLifecycle from './task-lifecycle';
import { createRun, type DelegatedRun } from './types';

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

type Handler = (...args: unknown[]) => unknown;

const config: DelegateConfig = {
  timeoutMs: 60_000,
  maxParallelTasks: 2,
  maxConcurrency: 2,
  provider: 'test',
  modelCatalog: {
    quick: {
      model: 'test-model',
      thinking: 'low',
      relativeCost: 1,
      useFor: 'cheap checks',
      avoid: 'judgement calls',
    },
  },
};

function prepared(
  task = 'inspect independently',
  token = 'continuation-token',
): PreparedDelegateTask {
  return {
    plan: {
      name: `${task} agent`,
      task,
      requestedCwd: '/tmp/project',
      context: 'fresh',
      writeRequested: false,
      isolation: 'shared',
      routeOverride: false,
      warnings: [],
      routing: {
        route: 'quick',
        provider: 'test',
        model: 'test-model',
        thinking: 'low',
        relativeCost: 1,
      },
    },
    session: {
      token,
      filePath: '/tmp/delegate.jsonl',
      cwd: '/tmp/project',
      isolation: 'shared',
    },
    cwd: '/tmp/project',
    allowWrites: false,
    isolation: 'shared',
    warnings: [],
  };
}

function successfulRun(): DelegatedRun {
  const run = createRun('inspect independently', undefined, {
    continuation: 'continuation-token',
  });
  run.exitCode = 0;
  run.state = 'success';
  run.finishedAt = Date.now();
  run.messages = [
    {
      role: 'assistant',
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
      content: [{ type: 'text', text: 'Background finding.' }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  ];
  return run;
}

beforeEach(() => {
  vi.spyOn(sessionModule, 'pruneDelegateSessions').mockReturnValue({
    removed: 0,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('async delegate extension', () => {
  test('returns a job immediately and steers its completion later', async () => {
    let finish!: (run: DelegatedRun) => void;
    vi.spyOn(configModule, 'loadDelegateConfig').mockReturnValue(config);
    vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockResolvedValue(
      prepared(),
    );
    vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockImplementation(
      () =>
        new Promise<DelegatedRun>((resolve) => {
          finish = resolve;
        }),
    );

    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const sendMessage = vi.fn();
    const registerMessageRenderer = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer,
      sendMessage,
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: '/tmp/project',
      hasUI: false,
      mode: 'print',
      sessionManager: {
        getHeader: () => ({
          type: 'session',
          version: 4,
          id: 'parent',
          timestamp: new Date().toISOString(),
          cwd: '/tmp/project',
        }),
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;

    delegate(pi);
    const completionRenderer = registerMessageRenderer.mock.calls[0]?.[1] as
      | ((
          message: { content: string; details: unknown },
          options: { expanded: boolean },
          theme: { fg: (color: string, text: string) => string },
        ) => { render: (width: number) => string[] })
      | undefined;
    const compactCompletion =
      completionRenderer?.(
        {
          content: `First line\n\n${'long output '.repeat(40)}`,
          details: { jobs: [{ state: 'success' }] },
        },
        { expanded: false },
        { fg: (_color, text) => text },
      )
        .render(200)
        .join('\n') ?? '';
    expect(compactCompletion.split('\n')).toHaveLength(1);
    expect(compactCompletion).toContain('…');

    handlers.get('session_start')?.({}, ctx);
    const delegateTool = tools.get('delegate');
    expect(delegateTool).toBeDefined();
    expect(tools.has('delegate_jobs')).toBe(true);

    const launch = await delegateTool?.execute(
      'call-1',
      {
        name: 'Independent inspection',
        task: 'inspect independently',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(launch?.content[0]?.text).toContain(
      'Started 1 background delegate job: dj-1',
    );
    expect(launch?.content[0]?.text).toContain('continuation-token');
    expect(sendMessage).not.toHaveBeenCalled();

    finish(successfulRun());
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: 'delegate-job-result',
      content: expect.stringContaining('Background finding.'),
      display: true,
    });
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({
      deliverAs: 'steer',
      triggerTurn: true,
    });

    const peek = await tools
      .get('delegate_jobs')
      ?.execute(
        'call-2',
        { action: 'peek', id: 'dj-1' },
        undefined,
        undefined,
        ctx,
      );
    expect(peek?.content[0]?.text).toContain('Background finding.');
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('creates and settles one background job per batch subagent', async () => {
    vi.spyOn(configModule, 'loadDelegateConfig').mockReturnValue(config);
    vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockImplementation(
      async (plan) => prepared(plan.task, `token-${plan.task}`),
    );
    const finishes = new Map<string, (run: DelegatedRun) => void>();
    vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockImplementation(
      (item) =>
        new Promise<DelegatedRun>((resolve) => {
          finishes.set(item.plan.task, resolve);
        }),
    );

    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const sendMessage = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: '/tmp/project',
      hasUI: false,
      mode: 'print',
      sessionManager: { getHeader: () => ({}), getBranch: () => [] },
    } as unknown as ExtensionContext;

    delegate(pi);
    handlers.get('session_start')?.({}, ctx);
    const launch = await tools.get('delegate')?.execute(
      'call-batch',
      {
        tasks: [
          { name: 'First agent', task: 'first', route: 'quick' },
          { name: 'Second agent', task: 'second', route: 'quick' },
        ],
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(launch?.content[0]?.text).toContain(
      'Started 2 background delegate jobs: dj-1, dj-2',
    );

    const first = successfulRun();
    first.task = 'first';
    first.messages[0] = {
      ...first.messages[0],
      content: [{ type: 'text', text: 'First finding.' }],
    } as never;
    finishes.get('first')?.(first);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage.mock.calls[0]?.[0].content).toContain('First finding.');

    const listed = await tools
      .get('delegate_jobs')
      ?.execute('call-list', { action: 'list' }, undefined, undefined, ctx);
    expect((listed?.details as { jobs?: unknown[] })?.jobs).toHaveLength(2);

    const second = successfulRun();
    second.task = 'second';
    second.messages[0] = {
      ...second.messages[0],
      content: [{ type: 'text', text: 'Second finding.' }],
    } as never;
    finishes.get('second')?.(second);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1]?.[0].content).toContain('Second finding.');
    await handlers.get('session_shutdown')?.({}, ctx);
  });

  test('shows live activity and suppresses delivery after tree navigation', async () => {
    const configLoader = vi
      .spyOn(configModule, 'loadDelegateConfig')
      .mockReturnValue(config);
    vi.spyOn(taskLifecycle, 'prepareDelegateTask').mockResolvedValue(
      prepared(),
    );
    let finish!: (run: DelegatedRun) => void;
    vi.spyOn(taskLifecycle, 'runPreparedDelegateTask').mockImplementation(
      (task, options) => {
        const live = createRun(task.plan.task, task.plan.routing, {
          name: task.plan.name,
        });
        live.state = 'running';
        live.startedAt = Date.now();
        live.activities.push({
          type: 'tool',
          label: 'bash npm test -- --changed',
          status: 'running',
        });
        options.onUpdate?.({
          content: [{ type: 'text', text: 'running' }],
          details: { mode: 'single', runs: [live] },
        });
        return new Promise<DelegatedRun>((resolve) => {
          finish = resolve;
        });
      },
    );

    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    >();
    const sendMessage = vi.fn();
    const notify = vi.fn();
    const setWidget = vi.fn();
    const getCommands = vi.fn(() => [
      {
        name: 'delegates',
        description: DELEGATES_COMMAND_DESCRIPTION,
        sourceInfo: { path: '/extensions/delegate/index.ts' },
      },
    ]);
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        },
      ) {
        commands.set(name, definition);
      },
      registerMessageRenderer: vi.fn(),
      sendMessage,
      getCommands,
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: '/tmp/project',
      hasUI: true,
      mode: 'tui',
      ui: { notify, setWidget },
      sessionManager: { getHeader: () => ({}), getBranch: () => [] },
    } as unknown as ExtensionContext;

    delegate(pi);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain('Comparison: unavailable');
    expect(notify.mock.calls[0]?.[0]).toContain(
      '/reload establishes prompt guidance',
    );
    notify.mockClear();
    handlers.get('session_start')?.({}, ctx);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Comparison: same'),
      'info',
    );
    expect(notify.mock.calls[0]?.[0]).toContain(
      'Extension source: /extensions/delegate/index.ts',
    );
    getCommands.mockReturnValue([
      {
        name: 'delegates',
        description: DELEGATES_COMMAND_DESCRIPTION,
        sourceInfo: { path: '/one.ts' },
      },
      {
        name: 'delegates',
        description: DELEGATES_COMMAND_DESCRIPTION,
        sourceInfo: { path: '/two.ts' },
      },
    ]);
    notify.mockClear();
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain('Extension source: unknown');
    notify.mockClear();
    getCommands.mockReturnValue([
      {
        name: 'delegates',
        description: DELEGATES_COMMAND_DESCRIPTION,
        sourceInfo: { path: '/extensions/delegate/index.ts' },
      },
    ]);
    const invalidConfig: DelegateConfig = {
      ...config,
      error: 'delegate.timeoutMs must be an integer between 10000 and 3600000.',
    };
    configLoader.mockReturnValue(invalidConfig);
    handlers.get('session_start')?.({}, ctx);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain('Comparison: same');
    expect(notify.mock.calls[0]?.[0]).toContain('valid=no');
    expect(notify.mock.calls[0]?.[0]).toContain(
      'Current settings: fingerprint=',
    );
    expect(notify.mock.calls[0]?.[0]).toContain('valid=no; routes=');
    expect(notify.mock.calls[0]?.[0]).toContain(
      'Fix current settings before delegating; delegate execution is unavailable with current settings.',
    );
    expect(notify.mock.calls[0]?.[0]).not.toContain(
      'Prompt guidance is current.',
    );
    notify.mockClear();
    configLoader.mockReturnValue(config);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain(
      '/reload refreshes prompt guidance. Delegate execution re-reads current settings on demand.',
    );
    notify.mockClear();
    handlers.get('session_start')?.({}, ctx);
    configLoader.mockReturnValue(invalidConfig);
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify.mock.calls[0]?.[0]).toContain(
      'Fix current settings before delegating; delegate execution is unavailable with current settings.',
    );
    expect(notify.mock.calls[0]?.[0]).not.toContain(
      'Prompt guidance is current',
    );
    notify.mockClear();
    configLoader.mockReturnValue({ ...config, timeoutMs: 120_000 });
    await commands.get('delegates')?.handler('config', ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Comparison: differs'),
      'info',
    );
    expect(notify.mock.calls[0]?.[0]).toContain(
      '/reload refreshes prompt guidance',
    );
    notify.mockClear();
    await commands.get('delegates')?.handler('unexpected', ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Unknown /delegates argument'),
      'error',
    );
    notify.mockClear();
    configLoader.mockReturnValue(config);
    await tools.get('delegate')?.execute(
      'call-1',
      {
        name: 'Independent inspection',
        task: 'inspect independently',
        route: 'quick',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    );
    const widgetFactory = [...setWidget.mock.calls]
      .reverse()
      .find((call) => typeof call[1] === 'function')?.[1] as
      | ((
          tui: unknown,
          theme: { fg: (color: string, text: string) => string },
        ) => { render: (width: number) => string[] })
      | undefined;
    const requestRender = vi.fn();
    const widget = widgetFactory?.(
      { requestRender },
      { fg: (_color, text) => text },
    );
    const widgetLines = widget?.render(100) ?? [];
    expect(widgetLines).toHaveLength(2);
    expect(widgetLines[0]).toContain('● inspect independently agent');
    expect(widgetLines[0]).toMatch(/\d+s$/);
    expect(widgetLines[1]).toContain('bash npm test -- --changed');
    expect(widgetLines.join('\n')).not.toMatch(
      /\b(?:Tool|Reasoning|Now|Last)\b/,
    );

    handlers.get('agent_start')?.({}, ctx);
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(
      setWidget.mock.calls.filter((call) => typeof call[1] === 'function'),
    ).toHaveLength(1);

    requestRender.mockClear();
    await commands.get('delegates')?.handler('', ctx);
    const compactFactory = [...setWidget.mock.calls]
      .reverse()
      .find(
        (call) => typeof call[1] === 'function',
      )?.[1] as typeof widgetFactory;
    const compactLine = widget?.render(100)[0] ?? '';
    expect(compactFactory).toBe(widgetFactory);
    expect(compactLine).toContain('1 subagent');
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(
      setWidget.mock.calls.filter((call) => typeof call[1] === 'function'),
    ).toHaveLength(1);
    expect(compactLine).not.toContain('inspect independently');
    expect(notify).not.toHaveBeenCalled();

    finish(successfulRun());
    await new Promise((resolve) => setTimeout(resolve, 0));
    handlers.get('session_tree')?.({}, ctx);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]?.[0]).toContain('another conversation branch');

    await commands.get('delegates')?.handler('', ctx);
    const foreground = tools.get('delegate')?.execute(
      'call-foreground',
      {
        name: 'Foreground audit',
        task: 'audit in the foreground',
        route: 'quick',
      },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => {
      const factory = [...setWidget.mock.calls]
        .reverse()
        .find((call) => typeof call[1] === 'function')?.[1] as
        | typeof widgetFactory
        | undefined;
      const output =
        factory?.(
          { requestRender: vi.fn() },
          { fg: (_color, text) => text },
        ).render(100) ?? [];
      expect(output.join('\n')).toContain('inspect independently agent');
      expect(output.join('\n')).toContain('bash npm test -- --changed');
    });
    finish(successfulRun());
    await foreground;
    await handlers.get('session_shutdown')?.({}, ctx);
  });
});
