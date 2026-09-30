import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BackgroundJobsClient } from '@pi-agent/background-jobs';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BackgroundJobHostService } from '../../apps/dashboard-server/src/background-job-host';
import { getScopedServices } from '../shared/runtime/scoped-services';
import backgroundTerminals from './index';
import type { ProcessDetails } from './schema';

interface Renderable {
  render: (width: number) => string[];
}

interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

interface RegisteredTool {
  name: string;
  outputSchema?: TSchema;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<unknown>;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ThemeLike,
    context: { expanded: boolean },
  ) => Renderable;
  renderResult?: (
    result: {
      content: Array<{ type: string; text: string }>;
      details?: Record<string, unknown>;
    },
    options: { expanded: boolean },
    theme: ThemeLike,
  ) => Renderable;
}

type Handler = (...args: unknown[]) => unknown;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalProcessSocket = process.env.PI_PROCESS_HOST_SOCKET;
let host: BackgroundJobHostService;
let hostRoot: string;
beforeAll(async () => {
  process.env.PI_CODING_AGENT_DIR = process.cwd();
  hostRoot = await mkdtemp(path.join(os.tmpdir(), 'background-index-'));
  const socket = path.join(hostRoot, 'jobs.sock');
  process.env.PI_PROCESS_HOST_SOCKET = socket;
  host = new BackgroundJobHostService(
    socket,
    path.join(hostRoot, 'jobs.sqlite'),
  );
  await host.listen();
});
afterAll(async () => {
  for (const owner of ['default', 'scope-A', 'scope-B']) {
    const client = new BackgroundJobsClient(host.socketPath, owner);
    const running = (await client.list())
      .filter((job) => job.status === 'running')
      .map((job) => job.id);
    if (running.length) await client.stop(running);
  }
  await host.close();
  await rm(hostRoot, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalProcessSocket === undefined)
    delete process.env.PI_PROCESS_HOST_SOCKET;
  else process.env.PI_PROCESS_HOST_SOCKET = originalProcessSocket;
});

describe('background terminals extension', () => {
  it('steers completion while busy and triggers a turn while idle', async () => {
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const sendMessage = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;

    backgroundTerminals(pi);
    const tool = tools.get('background_start');
    expect([...tools.keys()]).toEqual([
      'background_start',
      'background_peek',
      'background_list',
      'background_stop',
      'background_watch',
      'background_unwatch',
    ]);
    expect(tool?.name).toBe('background_start');
    expect(tool?.description).toContain(
      'Completion is delivered automatically',
    );
    expect(tool?.description).not.toContain(
      'waiting for the background process',
    );
    expect(tool?.description).toContain('/bin/bash -c');
    expect(tool?.description).toContain('no stdin');
    expect(tool?.description).not.toContain('do not block waiting here');
    expect(tool?.promptSnippet).toBe(
      'Start a long-running non-interactive Bash command',
    );
    const guidance = tool?.promptGuidelines?.join('\n');
    expect(guidance).toContain('use ordinary bash for short commands');
    expect(guidance).toContain('one short waiting notice');
    expect(guidance).toContain('kind: "task"');
    expect(guidance).toContain('kind: "service"');
    expect(guidance).toContain('task still waits for process exit');
    expect(guidance).toContain('includes retained settled watches');
    expect(guidance).toContain('use `background_stop` explicitly');

    handlers.get('session_start')?.(
      {},
      {
        cwd: process.cwd(),
        hasUI: false,
        mode: 'print',
      },
    );
    await tool?.execute(
      'call-1',
      {
        command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
        title: 'quick task',
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      customType: 'pi-keyed-turn-control',
      details: {
        operation: 'schedule',
        timing: 'steer',
        key: expect.stringContaining('background-process:'),
        message: {
          customType: 'background-terminal-result',
          details: { dedupeKey: expect.any(String), id: expect.any(String) },
        },
      },
    });
    expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false });

    await handlers.get('session_shutdown')?.({});
  });

  it('does not publish a passive service late exit, but publishes a fast required task', async () => {
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const sendMessage = vi.fn();
    backgroundTerminals({
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI);
    const scope = `required-delivery-${randomUUID()}`;
    const services = getScopedServices(scope);
    const required = new Set<string>();
    services.requestDependencies = {
      register: (kind, id) => {
        required.add(`${kind}:${id}`);
        return true;
      },
      resolveDelegateGate: () => undefined,
      hasPending: () => required.size > 0,
      isRequired: (kind, id) => required.has(`${kind}:${id}`),
    };
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      mode: 'print',
      sessionManager: { getSessionId: () => scope, getBranch: () => [] },
    } as unknown as { cwd: string };
    handlers.get('session_start')?.({}, ctx);
    const client = new BackgroundJobsClient(host.socketPath, scope);
    try {
      const start = tools.get('background_start');
      if (!start) throw new Error('missing start tool');
      const service = (await start.execute(
        'passive',
        { kind: 'service', command: 'sleep 0.1' },
        undefined,
        undefined,
        ctx,
      )) as { details: { process: ProcessDetails } };
      await vi.waitFor(async () =>
        expect((await client.inspect(service.details.process.id))?.status).toBe(
          'done',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(sendMessage).not.toHaveBeenCalled();
      const task = (await start.execute(
        'fast-task',
        { command: 'true' },
        undefined,
        undefined,
        ctx,
      )) as { details: { process: ProcessDetails } };
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
      expect(JSON.stringify(sendMessage.mock.calls)).toContain(
        task.details.process.id,
      );
      required.clear();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      services.requestDependencies = undefined;
      await handlers.get('session_shutdown')?.({}, ctx);
    }
  });

  it('registers task exits and watch outcomes at background source creation, but not passive service exits', async () => {
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    backgroundTerminals(pi);
    const scope = `request-dependencies-${randomUUID()}`;
    const services = getScopedServices(scope);
    const registered: Array<{ kind: string; id: string }> = [];
    const rejectedIds: string[] = [];
    let rejectNext = false;
    services.requestDependencies = {
      register: (kind, id) => {
        if (rejectNext) {
          rejectNext = false;
          rejectedIds.push(id);
          return false;
        }
        registered.push({ kind, id });
        return true;
      },
      resolveDelegateGate: () => undefined,
      hasPending: () => registered.length > 0,
    };
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      mode: 'print',
      sessionManager: { getSessionId: () => scope, getBranch: () => [] },
    } as unknown as { cwd: string };
    handlers.get('session_start')?.({}, ctx);
    const client = new BackgroundJobsClient(host.socketPath, scope);
    const stopIds: string[] = [];
    try {
      const start = tools.get('background_start');
      if (!start) throw new Error('background_start was not registered');
      const task = (await start.execute(
        'task',
        { command: 'sleep 30' },
        undefined,
        undefined,
        ctx,
      )) as { details: { process: ProcessDetails } };
      stopIds.push(task.details.process.id);
      const service = (await start.execute(
        'service',
        { kind: 'service', command: 'sleep 30' },
        undefined,
        undefined,
        ctx,
      )) as { details: { process: ProcessDetails } };
      stopIds.push(service.details.process.id);
      const watchedService = (await start.execute(
        'watched-service',
        {
          kind: 'service',
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write("READY");setInterval(() => {}, 1000)')}`,
          watch: [{ contains: 'READY', timeout_seconds: 2 }],
        },
        undefined,
        undefined,
        ctx,
      )) as { details: { process: ProcessDetails } };
      stopIds.push(watchedService.details.process.id);
      const watchId = watchedService.details.process.watches?.[0]?.id;
      expect(registered).toEqual([
        { kind: 'process', id: task.details.process.id },
        ...(watchId
          ? [
              {
                kind: 'watch',
                id: `${watchedService.details.process.id}:${watchId}`,
              },
            ]
          : []),
      ]);
      expect(await client.inspect(service.details.process.id)).toMatchObject({
        status: 'running',
      });
      rejectNext = true;
      await expect(
        start.execute(
          'unowned-task',
          { kind: 'task', command: 'sleep 30' },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow('Could not bind the background source');
      expect(rejectedIds).toHaveLength(1);
      expect(await client.inspect(rejectedIds[0] ?? '')).toMatchObject({
        status: 'killed',
      });
    } finally {
      if (stopIds.length) await client.stop(stopIds);
      services.requestDependencies = undefined;
      handlers.get('session_shutdown')?.({}, ctx);
    }
  });

  it('delivers and durably ACKs a watch before process exit', async () => {
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    let tool!: RegisteredTool;
    const sendMessage = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;
    backgroundTerminals(pi);
    tool = tools.get('background_start') as RegisteredTool;
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      mode: 'print',
      sessionManager: { getSessionId: () => 'watch-integration' },
    };
    handlers.get('session_start')?.({}, ctx);
    const client = new BackgroundJobsClient(
      host.socketPath,
      'watch-integration',
    );
    let id: string | undefined;
    try {
      const result = (await tool.execute(
        'launch',
        {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write("READY");setInterval(() => {}, 1000)')}`,
          watch: [{ contains: 'READY', timeout_seconds: 2 }],
        },
        undefined,
        undefined,
        ctx,
      )) as {
        content: Array<{ type: string; text: string }>;
        details: { process: ProcessDetails };
        structuredContent: unknown;
      };
      if (!tool.outputSchema) throw new Error('Missing output schema');
      expect(Value.Check(tool.outputSchema, result.structuredContent)).toBe(
        true,
      );
      expect(result.structuredContent).toMatchObject({
        action: 'start',
        process: {
          id: result.details.process.id,
          watches: [expect.objectContaining({ contains: 'READY' })],
        },
      });
      id = result.details.process.id;
      const watchId = result.details.process.watches?.[0]?.id;
      expect(watchId).toBeDefined();
      expect(result.content[0].text).toContain('"READY"');
      expect(result.content[0].text).toContain(watchId);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
      const control = sendMessage.mock.calls[0][0];
      expect(control.details).toMatchObject({
        timing: 'steer',
        message: {
          customType: 'background-watch-result',
          details: { id, watchId, status: 'matched' },
        },
      });
      expect(control.details.message.content).toContain('READY');
      expect(await client.inspect(id)).toMatchObject({
        status: 'running',
        watches: [{ status: 'matched', delivered: false }],
      });
      handlers.get('context')?.({ messages: [control.details.message] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await client.inspect(id))?.watches?.[0]?.delivered).toBe(false);
      handlers.get('context_with_system')?.({ messages: [] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await client.inspect(id))?.watches?.[0]?.delivered).toBe(false);
      handlers.get('context_with_system')?.(
        { messages: [control.details.message] },
        ctx,
      );
      await vi.waitFor(async () => {
        expect(
          (await client.inspect(id as string))?.watches?.[0]?.delivered,
        ).toBe(true);
      });
      await handlers.get('session_shutdown')?.({}, ctx);
      handlers.get('session_start')?.({}, ctx);
      await (tools.get('background_list') as RegisteredTool).execute(
        'list',
        {},
        undefined,
        undefined,
        ctx,
      );
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      if (id) await client.stop([id]);
      await handlers.get('session_shutdown')?.({}, ctx);
    }
  });

  it('delivers one completion for multiple unmatched watches and ACKs them across reconnects', async () => {
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    let tool!: RegisteredTool;
    const sendMessage = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;
    backgroundTerminals(pi);
    tool = tools.get('background_start') as RegisteredTool;
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      mode: 'print',
      sessionManager: { getSessionId: () => 'ended-integration' },
    };
    handlers.get('session_start')?.({}, ctx);
    const client = new BackgroundJobsClient(
      host.socketPath,
      'ended-integration',
    );
    try {
      const started = (await tool.execute(
        'launch',
        {
          command: 'printf "finished\\n"',
          watch: [
            { contains: 'ready', stream: 'stdout' },
            { contains: 'healthy' },
          ],
        },
        undefined,
        undefined,
        ctx,
      )) as { details: { process: ProcessDetails } };
      const id = started.details.process.id;
      await client.wait(id, 1000);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
      const message = sendMessage.mock.calls[0][0].details.message;
      expect(message.customType).toBe('background-terminal-result');
      expect(message.details.endedWatches).toEqual([
        { id: expect.any(String), contains: 'ready', stream: 'stdout' },
        { id: expect.any(String), contains: 'healthy' },
      ]);
      expect(message.content).toContain('not observed before process exit');
      expect(message.content).toContain('finished');
      expect((await client.inspect(id))?.completionDelivered).toBe(false);
      expect(
        (await client.inspect(id))?.watches?.every((watch) => !watch.delivered),
      ).toBe(true);
      handlers.get('context')?.({ messages: [message] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await client.inspect(id))?.completionDelivered).toBe(false);
      handlers.get('context_with_system')?.({ messages: [] }, ctx);
      expect((await client.inspect(id))?.completionDelivered).toBe(false);
      handlers.get('context_with_system')?.({ messages: [message] }, ctx);
      await vi.waitFor(async () => {
        const snapshot = await client.inspect(id);
        expect(snapshot?.completionDelivered).toBe(true);
        expect(snapshot?.watches?.every((watch) => watch.delivered)).toBe(true);
      });
      await handlers.get('session_shutdown')?.({}, ctx);
      handlers.get('session_start')?.({}, ctx);
      await (tools.get('background_list') as RegisteredTool).execute(
        'list',
        {},
        undefined,
        undefined,
        ctx,
      );
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      await handlers.get('session_shutdown')?.({}, ctx);
    }
  });

  it('ignores a late shutdown from a replaced session scope', async () => {
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    let tool: RegisteredTool | undefined;
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    backgroundTerminals(pi);
    tool = tools.get('background_start');
    const context = (scope: string) => ({
      cwd: process.cwd(),
      hasUI: false,
      mode: 'print' as const,
      sessionManager: { getSessionId: () => scope },
    });
    const start = handlers.get('session_start');
    const shutdown = handlers.get('session_shutdown');
    start?.({}, context('scope-A'));
    start?.({}, context('scope-B'));
    try {
      const result = await tool?.execute(
        'call-1',
        {
          command: 'while true; do sleep 1; done',
          title: 'scope B server',
        },
        undefined,
        undefined,
        { cwd: process.cwd() },
      );
      const processId = (result as { details?: { process?: { id: string } } })
        .details?.process?.id;
      expect(processId).toBeDefined();

      await shutdown?.({}, context('scope-A'));
      const listed = await tools
        .get('background_list')
        ?.execute('call-2', {}, undefined, undefined, { cwd: process.cwd() });
      expect(
        (listed as { details?: { processes?: unknown[] } }).details?.processes,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: processId })]),
      );
    } finally {
      await shutdown?.({}, context('scope-B'));
    }
  });

  it('renders automatic completions as padded status cards', () => {
    let completionRenderer:
      | ((
          message: { content: string; details?: Record<string, unknown> },
          options: { expanded: boolean; outputPad: number },
          theme: ThemeLike,
        ) => Renderable)
      | undefined;
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(
        (type: string, renderer: typeof completionRenderer) => {
          if (type === 'background-terminal-result')
            completionRenderer = renderer;
        },
      ),
    } as unknown as ExtensionAPI;
    const theme: ThemeLike = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => text,
    };

    backgroundTerminals(pi);
    const message = {
      content:
        'Background process bg-1 completed. Use background_peek to inspect it.',
      details: {
        id: 'bg-1',
        title: 'production build',
        status: 'done',
        exitCode: 0,
        duration: '4s',
        outcome: 'exit 0',
      },
    };
    const compact =
      completionRenderer?.(message, { expanded: false, outputPad: 1 }, theme)
        .render(160)
        .join('\n') ?? '';
    expect(compact).toContain(
      '<success>✓</success> <muted>Background process </muted><text>production build</text><dim> · finished · 4s</dim>',
    );
    expect(compact.startsWith(' ')).toBe(true);
    expect(compact).not.toContain('Use background_peek');
    expect(compact).not.toContain('bg-1');

    const expanded =
      completionRenderer?.(message, { expanded: true, outputPad: 1 }, theme)
        .render(160)
        .join('\n') ?? '';
    expect(expanded).toContain(
      '<text>production build</text><dim> · exit 0</dim>',
    );
    expect(expanded).not.toContain('bg-1');
    expect(expanded).not.toContain('Use background_peek');
  });

  it('reasserts a colored widget at agent boundaries', async () => {
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const setWidget = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    backgroundTerminals(pi);
    const tool = tools.get('background_start');
    handlers.get('session_start')?.(
      {},
      {
        cwd: process.cwd(),
        hasUI: true,
        mode: 'tui',
        ui: { setWidget },
      },
    );
    await tool?.execute(
      'call-1',
      {
        command: 'while true; do sleep 1; done',
        title: 'server',
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    const callsAfterStart = setWidget.mock.calls.length;
    handlers.get('agent_start')?.({});
    expect(setWidget).toHaveBeenCalledTimes(callsAfterStart + 1);
    const factory = setWidget.mock.calls.at(-1)?.[1] as
      | ((tui: unknown, theme: ThemeLike) => Renderable)
      | undefined;
    const theme: ThemeLike = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => text,
    };
    const line = factory?.({}, theme).render(120)[0] ?? '';
    expect(line).toContain('<warning>■ </warning>');
    expect(line).toContain('<accent>/ps</accent>');

    await handlers.get('session_shutdown')?.({});
  });

  it('renders compact colored calls and results', () => {
    const tools = new Map<string, RegisteredTool>();
    const pi = {
      on: vi.fn(),
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
    } as unknown as ExtensionAPI;
    const theme: ThemeLike = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => `**${text}**`,
    };

    backgroundTerminals(pi);
    const tool = tools.get('background_start');
    const partial = tool?.renderCall?.({}, theme, { expanded: false });
    const call = tool?.renderCall?.(
      {
        title: 'development server',
        command: `printf %s ${'x'.repeat(200)}`,
      },
      theme,
      { expanded: false },
    );
    const result = tool?.renderResult?.(
      {
        content: [{ type: 'text', text: 'full output that stays hidden' }],
        details: {
          action: 'start',
          process: {
            id: 'bg-1',
            title: 'development server',
            status: 'running',
            stdoutBytes: 0,
            stderrBytes: 0,
          },
        },
      },
      { expanded: false },
      theme,
    );

    expect(partial?.render(160).join('\n')).toContain('background');
    expect(call?.render(160).join('\n')).toContain('…');
    expect(result?.render(160).join('\n')).toContain(
      '<warning>● development server running',
    );
    expect(result?.render(160).join('\n')).not.toContain('bg-1');
    expect(result?.render(160).join('\n')).not.toContain('full output');
  });
});
