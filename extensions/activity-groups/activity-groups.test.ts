import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { createActivityGroupRenderer } from './renderer';
import type { RendererContext, SequenceSnapshot } from './types';

function message(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 1000,
  };
}

function context(): RendererContext {
  return { state: new Map(), requestRender() {} };
}

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
} as Theme;

describe('activity groups renderer', () => {
  it('renders compact live and completed summaries with expandable defaults', () => {
    const renderer = createActivityGroupRenderer();
    const defaultView = new Text('ORIGINAL_DETAILS', 0, 0);
    const ctx = context();
    const live: SequenceSnapshot = {
      id: 'sequence-1',
      cwd: process.cwd(),
      startedAt: 1000,
      failed: false,
      items: [
        {
          type: 'assistant',
          message: message([
            {
              type: 'thinking',
              thinking: '**Inspecting authentication code**',
            },
          ]),
          provisional: false,
        },
        {
          type: 'tool',
          id: 'read-1',
          name: 'read',
          args: { path: 'src/auth.ts' },
          status: 'running',
          isError: false,
        },
      ],
    };

    const component = renderer(
      live,
      { streaming: true, expanded: false, defaultView },
      theme,
      ctx,
    );
    if (!component) throw new Error('renderer returned no component');
    ctx.lastComponent = component;
    const liveOutput = component.render(100).join('\n');
    expect(liveOutput).toContain('Inspecting authentication code');
    expect(liveOutput).toContain('Reading src/auth.ts');
    expect(liveOutput).toContain('1 call · 1 file');
    expect(liveOutput).not.toContain('ORIGINAL_DETAILS');

    const completed = { ...live, completedAt: 2250 };
    const sameComponent = renderer(
      completed,
      { streaming: false, expanded: true, defaultView },
      theme,
      ctx,
    );
    expect(sameComponent).toBe(component);
    const completedOutput = component.render(100).join('\n');
    expect(completedOutput).toContain('Inspected authentication code');
    expect(completedOutput).toContain('1.3s');
    expect(completedOutput).toContain('ORIGINAL_DETAILS');
    (component as unknown as { dispose(): void }).dispose();
  });

  it('omits the duration for sequences replayed from history', () => {
    const renderer = createActivityGroupRenderer();
    const ctx = context();
    const component = renderer(
      {
        id: 'sequence-3',
        cwd: process.cwd(),
        startedAt: 1000,
        failed: false,
        items: [
          {
            type: 'tool',
            id: 'read-1',
            name: 'read',
            args: { path: 'src/auth.ts' },
            status: 'complete',
            isError: false,
          },
        ],
      },
      { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
      theme,
      ctx,
    );
    if (!component) throw new Error('renderer returned no component');
    const output = component.render(100).join('\n');
    expect(output).toContain('1 call · 1 file');
    expect(output).not.toMatch(/\dms|\ds\b/);
    (component as unknown as { dispose(): void }).dispose();
  });

  it('keeps failures prominent', () => {
    const renderer = createActivityGroupRenderer();
    const component = renderer(
      {
        id: 'sequence-2',
        cwd: process.cwd(),
        startedAt: 1000,
        completedAt: 1200,
        failed: true,
        items: [
          {
            type: 'tool',
            id: 'read-1',
            name: 'read',
            args: { path: 'missing.ts' },
            status: 'complete',
            isError: true,
          },
        ],
      },
      { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
      theme,
      context(),
    );
    if (!component) throw new Error('renderer returned no component');
    const output = component.render(100).join('\n');
    expect(output).toContain('✗ Explored missing.ts');
    expect(output).toContain('1 failed');
    (component as unknown as { dispose(): void }).dispose();
  });

  it('tracks the newest narration while live and the intent once settled', () => {
    const renderer = createActivityGroupRenderer();
    const ctx = context();
    const sequence: SequenceSnapshot = {
      id: 'sequence-4',
      cwd: process.cwd(),
      startedAt: 1000,
      failed: false,
      items: [
        {
          type: 'assistant',
          message: message([
            {
              type: 'thinking',
              thinking: '**Planning repository inspection**',
            },
          ]),
          provisional: false,
        },
        {
          type: 'tool',
          id: 'read-1',
          name: 'read',
          args: { path: 'extensions/delegate/jobs.ts' },
          status: 'complete',
          isError: false,
        },
        {
          type: 'assistant',
          message: message([
            {
              type: 'thinking',
              thinking:
                'some prose\n\n**Identifying race condition in shutdown**\n\nmore prose',
            },
          ]),
          provisional: false,
        },
        {
          type: 'tool',
          id: 'read-2',
          name: 'read',
          args: { path: 'extensions/delegate/tool.ts' },
          status: 'running',
          isError: false,
        },
      ],
    };

    const component = renderer(
      sequence,
      { streaming: true, expanded: false, defaultView: new Text('', 0, 0) },
      theme,
      ctx,
    );
    if (!component) throw new Error('renderer returned no component');
    ctx.lastComponent = component;
    // Live: the newest header, so the line says what is happening right now.
    expect(component.render(100).join('\n')).toContain(
      'Identifying race condition in shutdown',
    );

    renderer(
      { ...sequence, completedAt: 4000 },
      { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
      theme,
      ctx,
    );
    const settled = component.render(100).join('\n');
    // Settled: the earliest header naming real work, in past tense. The
    // "Planning …" preamble the group opened with is skipped.
    expect(settled).toContain('Identified race condition in shutdown');
    expect(settled).not.toContain('Planned');
    // The shared directory locates the group at a glance.
    expect(settled).toContain('2 files in extensions/delegate');
    (component as unknown as { dispose(): void }).dispose();
  });
});
