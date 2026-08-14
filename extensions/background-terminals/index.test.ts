import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import backgroundTerminals from './index';
import type { BackgroundParameters } from './schema';

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
beforeAll(() => {
  process.env.PI_CODING_AGENT_DIR = process.cwd();
});
afterAll(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
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
    expect(sendMessage.mock.calls[0][1]).toEqual({
      deliverAs: 'steer',
      triggerTurn: true,
    });

    await handlers.get('session_shutdown')?.({});
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
        (_type: string, renderer: typeof completionRenderer) => {
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
