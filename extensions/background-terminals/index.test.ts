import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import backgroundTerminals from './index';

interface Renderable {
  render: (width: number) => string[];
}

interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    params: {
      action: 'start' | 'peek' | 'list' | 'stop';
      command?: string;
      title?: string;
      cwd?: string;
      id?: string;
      ids?: string[];
      wait_seconds?: number;
      tail_lines?: number;
    },
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
