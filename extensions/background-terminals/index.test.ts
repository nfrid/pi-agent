import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BackgroundJobsClient } from '@pi-agent/background-jobs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BackgroundJobHostService } from '../../apps/dashboard-server/src/background-job-host';
import backgroundTerminals from './index';
import type { BackgroundParameters, ProcessDetails } from './schema';

interface Renderable {
  render: (width: number) => string[];
}

interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    id: string,
    params: BackgroundParameters,
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
    let tool: RegisteredTool | undefined;
    const sendMessage = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;

    backgroundTerminals(pi);
    expect(tool?.name).toBe('background');
    expect(tool?.description).toContain(
      'Completion is delivered automatically.',
    );
    expect(tool?.description).not.toContain(
      'waiting for the background process',
    );
    expect(tool?.description).toContain('/bin/bash -c');
    expect(tool?.description).toContain('no stdin');
    expect(tool?.description).not.toContain('do not block waiting here');
    expect(tool?.promptSnippet).toBe(
      'Run and manage long-running non-interactive Bash commands',
    );
    expect(tool?.promptGuidelines).toEqual([
      'When a background process is the only remaining dependency, end the turn with one short waiting notice; do not recap or poll because completion resumes automatically.',
      'Use `background` for non-interactive commands that should outlive the current turn; use ordinary bash for short commands.',
      '`start` accepts an optional title (otherwise it is derived from the command) and optional one-shot `watch` entries. A watch is literal, case-sensitive, single-line text observed only in future stdout/stderr; it notifies on match, timeout, or process end and never kills the process. Keep at most 8 watches per process.',
      'Use `background peek` for an immediate snapshot; it never waits. Use `list` for process and watch status, `watch` to append watches, `unwatch` to remove them, and `stop` to terminate processes.',
      'Example: start a server with `watch: [{"contains":"ready","stream":"stdout","timeout_seconds":60}]`, then continue without polling. Completion and watch notifications resume the agent turn automatically.',
      'Background jobs survive parent Pi session shutdown and recreation; use `background stop` explicitly when a job should terminate.',
    ]);

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
        action: 'start',
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

  it('delivers and durably ACKs a watch before process exit', async () => {
    const handlers = new Map<string, Handler>();
    let tool!: RegisteredTool;
    const sendMessage = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;
    backgroundTerminals(pi);
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
          action: 'start',
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write("READY");setInterval(() => {}, 1000)')}`,
          watch: [{ contains: 'READY', timeout_seconds: 2 }],
        },
        undefined,
        undefined,
        ctx,
      )) as {
        content: Array<{ type: string; text: string }>;
        details: { process: ProcessDetails };
      };
      id = result.details.process.id;
      const watchId = result.details.process.watches?.[0]?.id;
      expect(watchId).toBeDefined();
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
      await vi.waitFor(async () => {
        expect(
          (await client.inspect(id as string))?.watches?.[0]?.delivered,
        ).toBe(true);
      });
      await handlers.get('session_shutdown')?.({}, ctx);
      handlers.get('session_start')?.({}, ctx);
      await tool.execute('list', { action: 'list' }, undefined, undefined, ctx);
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      if (id) await client.stop([id]);
      await handlers.get('session_shutdown')?.({}, ctx);
    }
  });

  it('delivers one completion for multiple unmatched watches and ACKs them across reconnects', async () => {
    const handlers = new Map<string, Handler>();
    let tool!: RegisteredTool;
    const sendMessage = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage,
    } as unknown as ExtensionAPI;
    backgroundTerminals(pi);
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
          action: 'start',
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
      await vi.waitFor(async () => {
        const snapshot = await client.inspect(id);
        expect(snapshot?.completionDelivered).toBe(true);
        expect(snapshot?.watches?.every((watch) => watch.delivered)).toBe(true);
      });
      await handlers.get('session_shutdown')?.({}, ctx);
      handlers.get('session_start')?.({}, ctx);
      await tool.execute('list', { action: 'list' }, undefined, undefined, ctx);
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      await handlers.get('session_shutdown')?.({}, ctx);
    }
  });

  it('ignores a late shutdown from a replaced session scope', async () => {
    const handlers = new Map<string, Handler>();
    let tool: RegisteredTool | undefined;
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    backgroundTerminals(pi);
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
          action: 'start',
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
      const listed = await tool?.execute(
        'call-2',
        { action: 'list' },
        undefined,
        undefined,
        { cwd: process.cwd() },
      );
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
        'Background process bg-1 completed. Use background peek to inspect it.',
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
    expect(compact).not.toContain('Use background peek');
    expect(compact).not.toContain('bg-1');

    const expanded =
      completionRenderer?.(message, { expanded: true, outputPad: 1 }, theme)
        .render(160)
        .join('\n') ?? '';
    expect(expanded).toContain('<accent>bg-1</accent><dim> · exit 0</dim>');
    expect(expanded).not.toContain('Use background peek');
  });

  it('reasserts a colored widget at agent boundaries', async () => {
    const handlers = new Map<string, Handler>();
    let tool: RegisteredTool | undefined;
    const setWidget = vi.fn();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    backgroundTerminals(pi);
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
        action: 'start',
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
    let tool: RegisteredTool | undefined;
    const pi = {
      on: vi.fn(),
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
    } as unknown as ExtensionAPI;
    const theme: ThemeLike = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => `**${text}**`,
    };

    backgroundTerminals(pi);
    const partial = tool?.renderCall?.({}, theme, { expanded: false });
    const call = tool?.renderCall?.(
      {
        action: 'start',
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
    expect(result?.render(160).join('\n')).toContain('<warning>● bg-1 running');
    expect(result?.render(160).join('\n')).not.toContain('full output');
  });
});
