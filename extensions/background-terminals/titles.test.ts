import type {
  ExtensionAPI,
  Theme,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerBackgroundCommands } from './commands';
import { formatPeek, formatSummary } from './format';
import type { BackgroundManager, BackgroundSnapshot } from './manager';
import {
  registerBackgroundMessageRenderer,
  renderBackgroundCall,
  renderBackgroundResult,
} from './renderers';
import {
  type BackgroundToolDetails,
  type PeekParameters,
  type ProcessDetails,
  processDetails,
} from './schema';
import { registerBackgroundTools } from './tool';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const snapshot = (id: string, title = 'Dev server'): BackgroundSnapshot => ({
  id,
  title,
  command: 'echo ready',
  cwd: '/tmp',
  ownerSession: 'test',
  status: 'running',
  createdAt: 1,
  stdout: { text: '', totalBytes: 0, droppedBytes: 0 },
  stderr: { text: '', totalBytes: 0, droppedBytes: 0 },
  watches: [
    { id: 'watch-opaque', contains: 'ready', status: 'pending', createdAt: 1 },
  ],
});
const text = (value: { render(width: number): string[] }) =>
  value.render(400).join('\n');

describe('background title presentation', () => {
  it('reuses historical result titles without accessing the host during render', () => {
    type State = { processes?: Map<string, ProcessDetails> };
    let tool!: ToolDefinition<
      typeof PeekParameters,
      BackgroundToolDetails,
      State
    >;
    const getManager = vi.fn(() => {
      throw new Error('Rendering must not access the manager');
    });
    registerBackgroundTools(
      {
        registerTool: (definition: typeof tool) => {
          if (definition.name === 'background_peek') tool = definition;
        },
      } as unknown as ExtensionAPI,
      getManager,
    );
    const context: Parameters<NonNullable<typeof tool.renderCall>>[2] = {
      args: { id: 'process-opaque' },
      toolCallId: 'historical',
      invalidate: vi.fn(),
      lastComponent: undefined,
      state: {},
      cwd: '/tmp',
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
    };
    tool.renderResult?.(
      {
        content: [],
        details: {
          action: 'peek',
          process: processDetails(snapshot('process-opaque')),
        },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    const rendered = tool.renderCall?.(
      { id: 'process-opaque' },
      theme,
      context,
    );
    expect(rendered && text(rendered)).toContain('Dev server');
    expect(rendered && text(rendered)).not.toContain('process-opaque');
    expect(getManager).not.toHaveBeenCalled();
    expect(context.invalidate).toHaveBeenCalledOnce();
  });

  it('uses cached titles for controls and friendly fallbacks for partial calls', () => {
    const resolve = (id: string) =>
      id === 'process-opaque' ? snapshot(id) : undefined;
    for (const action of ['peek', 'watch', 'unwatch']) {
      const args = {
        action,
        id: 'process-opaque',
        watch_ids: ['watch-opaque'],
      };
      const rendered = text(renderBackgroundCall(args, theme, {}, resolve));
      expect(rendered).toContain('Dev server');
      expect(rendered).not.toContain('process-opaque');
      expect(rendered).not.toContain('watch-opaque');
      expect(text(renderBackgroundCall(args, theme))).toContain(
        'Background process',
      );
    }
    expect(text(renderBackgroundCall({}, theme))).toContain('background');
    const stopped = text(
      renderBackgroundCall(
        { action: 'stop', ids: ['one', 'two'] },
        theme,
        { expanded: true },
        (id) => snapshot(id, id === 'one' ? 'Dev server' : 'Build'),
      ),
    );
    expect(stopped).toContain('Dev server, Build');
  });

  it('keeps IDs in machine results but not ordinary rendered summaries', () => {
    const process = snapshot('process-opaque');
    expect(formatSummary(process)).toContain('process-opaque');
    expect(formatSummary(process)).toContain('watch-opaque');
    expect(formatPeek(process, 5)).toContain('process-opaque');
    expect(formatSummary(process, { human: true })).not.toContain('opaque');
    const result = {
      content: [{ type: 'text', text: formatSummary(process) }],
      details: { action: 'peek' as const, process: processDetails(process) },
    };
    const rendered = text(
      renderBackgroundResult(result, { expanded: false }, theme),
    );
    expect(rendered).toContain('Dev server');
    expect(rendered).not.toContain('opaque');
    expect(
      text(renderBackgroundResult(result, { expanded: true }, theme)),
    ).toContain('Raw process result:');
  });

  it('renders standalone watch notifications using title and condition', () => {
    type Renderer = (
      message: { details: unknown },
      options: { expanded: boolean; outputPad: number },
      theme: Theme,
    ) => { render(width: number): string[] };
    const renderers = new Map<string, Renderer>();
    registerBackgroundMessageRenderer({
      registerMessageRenderer: (type: string, renderer: Renderer) =>
        renderers.set(type, renderer),
    } as unknown as ExtensionAPI);
    const rendered = text(
      (renderers.get('background-watch-result') as Renderer)(
        {
          details: {
            id: 'process-opaque',
            watchId: 'watch-opaque',
            title: 'Dev server',
            status: 'matched',
            contains: 'ready',
          },
        },
        { expanded: true, outputPad: 0 },
        theme,
      ),
    );
    expect(rendered).toContain('Dev server');
    expect(rendered).toContain('"ready"');
    expect(rendered).not.toContain('opaque');
  });

  it('keeps duplicate titles selectable in /ps without showing IDs', async () => {
    let handler!: (_args: string, ctx: unknown) => Promise<void>;
    const processes = [snapshot('first-opaque'), snapshot('second-opaque')];
    const inspect = vi.fn().mockResolvedValue(processes[1]);
    const manager = {
      list: async () => processes,
      inspect,
    } as unknown as BackgroundManager;
    registerBackgroundCommands(
      {
        registerCommand: (
          _name: string,
          definition: { handler: typeof handler },
        ) => {
          handler = definition.handler;
        },
      } as unknown as ExtensionAPI,
      () => manager,
      () => false,
      () => {},
    );
    const select = vi.fn(async (_title: string, labels: string[]) => {
      expect(new Set(labels).size).toBe(2);
      expect(
        labels.every(
          (label) => label.includes('Dev server') && !label.includes('opaque'),
        ),
      ).toBe(true);
      return labels[1];
    });
    await handler('', {
      hasUI: true,
      mode: 'tui',
      ui: { select, notify: vi.fn() },
    });
    expect(inspect).toHaveBeenCalledWith('second-opaque');
  });
});
