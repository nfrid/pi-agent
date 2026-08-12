import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text, visibleWidth } from '@earendil-works/pi-tui';
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
  return { requestRender() {} };
}

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
} as Theme;

/** Marks every colour so a test can assert what was styled how. */
const paintedTheme = {
  fg(color: string, text: string) {
    return `<${color}>${text}</${color}>`;
  },
} as Theme;

function toolItem(
  id: string,
  name: string,
  args: unknown,
  isError: boolean,
): SequenceSnapshot['items'][number] {
  return { type: 'tool', id, name, args, status: 'complete', isError };
}

function preambleItem(
  text = 'Working on the requested change',
  id = 'preamble-call',
): SequenceSnapshot['items'][number] {
  return {
    type: 'assistant',
    message: message([
      { type: 'text', text },
      { type: 'toolCall', id, name: 'read', arguments: {} },
    ]),
  };
}

function renderOutcome(items: SequenceSnapshot['items']): string {
  const component = createActivityGroupRenderer()(
    {
      id: 'retry-sequence',
      cwd: process.cwd(),
      startedAt: 1000,
      completedAt: 2000,
      // Deliberately stale: aggregate outcome must come from the items.
      failed: true,
      items: [preambleItem('Retrying the failed work'), ...items],
    },
    { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
    theme,
    context(),
  );
  if (!component) throw new Error('renderer returned no component');
  const output = component.render(100).join('\n');
  (component as unknown as { dispose(): void }).dispose();
  return output;
}

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
            { type: 'text', text: 'Inspecting authentication code' },
            { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} },
          ]),
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
    expect(completedOutput).toContain('Inspecting authentication code');
    expect(completedOutput).toContain('1.3s');
    expect(completedOutput).toContain('ORIGINAL_DETAILS');
    (component as unknown as { dispose(): void }).dispose();
  });

  it('opts out of thinking-only and unpaired visible headers', () => {
    const renderer = createActivityGroupRenderer();
    const tool = toolItem(
      'read-1',
      'read',
      { path: 'extensions/activity-groups/renderer.ts' },
      false,
    );
    const sequence = (assistant: AssistantMessage): SequenceSnapshot => ({
      id: 'forming-group',
      cwd: process.cwd(),
      startedAt: 1000,
      failed: false,
      items: [{ type: 'assistant', message: assistant }, tool],
    });

    expect(
      renderer(
        sequence(
          message([
            { type: 'thinking', thinking: '**Inspecting the renderer**' },
          ]),
        ),
        { streaming: true, expanded: false, defaultView: new Text('', 0, 0) },
        paintedTheme,
        context(),
      ),
    ).toBeUndefined();
    expect(
      renderer(
        sequence(message([{ type: 'text', text: 'Inspecting the renderer' }])),
        { streaming: true, expanded: false, defaultView: new Text('', 0, 0) },
        paintedTheme,
        context(),
      ),
    ).toBeUndefined();
    expect(
      renderer(
        sequence(
          message([
            { type: 'text', text: '**Inspecting the renderer**' },
            { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} },
          ]),
        ),
        { streaming: true, expanded: false, defaultView: new Text('', 0, 0) },
        paintedTheme,
        context(),
      ),
    ).toBeUndefined();
    expect(
      renderer(
        {
          id: 'bare-tools',
          cwd: process.cwd(),
          startedAt: 1000,
          failed: false,
          items: [tool],
        },
        { streaming: true, expanded: false, defaultView: new Text('', 0, 0) },
        paintedTheme,
        context(),
      ),
    ).toBeUndefined();
  });

  it('wraps long titles instead of discarding their detail', () => {
    const component = createActivityGroupRenderer()(
      {
        id: 'long-title',
        cwd: process.cwd(),
        startedAt: 1000,
        completedAt: 2000,
        failed: false,
        items: [
          {
            type: 'assistant',
            message: message([
              {
                type: 'text',
                text: 'Checking how sessions expire across refreshes and reconnects',
              },
              { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} },
            ]),
          },
          toolItem('read-1', 'read', { path: 'src/session.ts' }, false),
        ],
      },
      { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
      theme,
      context(),
    );
    if (!component) throw new Error('renderer returned no component');

    const lines = component.render(32);
    expect(lines.map((line) => line.trim()).join(' ')).toContain(
      'Checking how sessions expire across refreshes and reconnects',
    );
    expect(lines.filter((line) => line.startsWith('   '))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('across refreshes and'),
        expect.stringContaining('reconnects'),
      ]),
    );
    expect(lines).not.toContain(expect.stringContaining('…'));
    expect(lines.every((line) => line.length <= 32)).toBe(true);

    const narrow = component.render(2);
    expect(narrow.join('').replaceAll(/\s/g, '')).toContain(
      'Checkinghowsessionsexpireacrossrefreshesandreconnects',
    );
    expect(narrow.every((line) => visibleWidth(line) <= 2)).toBe(true);
    (component as unknown as { dispose(): void }).dispose();
  });

  it('wraps long location metadata without losing the path', () => {
    const component = createActivityGroupRenderer()(
      {
        id: 'long-location',
        cwd: process.cwd(),
        startedAt: 1000,
        completedAt: 2000,
        failed: false,
        items: [
          preambleItem('Reviewing the session files'),
          toolItem(
            'read-1',
            'read',
            { path: 'src/a-very-long-directory-name/one.ts' },
            false,
          ),
          toolItem(
            'read-2',
            'read',
            { path: 'src/a-very-long-directory-name/two.ts' },
            false,
          ),
        ],
      },
      { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
      theme,
      context(),
    );
    if (!component) throw new Error('renderer returned no component');

    const lines = component.render(32);
    expect(lines.join('').replaceAll(/\s/g, '')).toContain(
      '2calls·2filesinsrc/a-very-long-directory-name',
    );
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
    (component as unknown as { dispose(): void }).dispose();
  });

  it('labels delegate and task actions with their useful subject', () => {
    const component = createActivityGroupRenderer()(
      {
        id: 'extension-actions',
        cwd: process.cwd(),
        startedAt: 1000,
        completedAt: 2000,
        failed: false,
        items: [
          preambleItem('Organizing the extension work'),
          toolItem('delegate-1', 'delegate', { name: 'Queue reviewer' }, false),
          toolItem('todo-1', 'todo', { action: 'start', id: 'T2' }, false),
          toolItem(
            'delegate-2',
            'delegate',
            { action: 'create', tasks: [{ name: 'A' }, { name: 'B' }] },
            false,
          ),
        ],
      },
      { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
      theme,
      context(),
    );
    if (!component) throw new Error('renderer returned no component');
    const output = component.render(100).join('\n');
    expect(output).toContain('Delegating Queue reviewer');
    expect(output).toContain('Tasks start T2');
    expect(output).toContain('Delegate create 2 subagents');
    (component as unknown as { dispose(): void }).dispose();
  });

  it('keeps the last steps legible and counts away the rest', () => {
    const renderer = createActivityGroupRenderer();
    const ctx = context();
    const tool = (
      id: string,
      name: string,
      args: Record<string, unknown>,
    ): SequenceSnapshot['items'][number] => ({
      type: 'tool',
      id,
      name,
      args,
      status: 'complete',
      isError: false,
    });
    const sequence: SequenceSnapshot = {
      id: 'sequence-5',
      cwd: process.cwd(),
      startedAt: 1000,
      completedAt: 5000,
      failed: false,
      items: [
        preambleItem('Reviewing and updating command workflows'),
        tool('e1', 'edit', { path: 'src/commands/workflows.ts' }),
        tool('e2', 'write', { path: 'src/commands/brief.ts' }),
        tool('r1', 'read', { path: 'src/commands/index.ts' }),
        tool('r2', 'read', { path: 'src/commands/types.ts' }),
        tool('g1', 'grep', { pattern: 'resolveVerification' }),
        // Chained one-liners are noise past the first segment.
        tool('b1', 'bash', {
          command: 'bun test src/commands && bunx biome ci',
        }),
      ],
    };

    const component = renderer(
      sequence,
      { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
      theme,
      ctx,
    );
    if (!component) throw new Error('renderer returned no component');
    const output = component.render(100).join('\n');
    // Each of the last three calls gets its own line, in the order they ran.
    expect(output).toContain('Reading src/commands/types.ts');
    expect(output).toContain('Searching for resolveVerification');
    expect(output).toContain('Running bun test src/commands');
    // Chained one-liners are noise past the first segment.
    expect(output).not.toContain('biome ci');
    // Everything before them is accounted for without being printed.
    expect(output).toContain('3 earlier steps');
    expect(output).not.toContain('workflows.ts');
    expect(output).toContain('6 calls');
    (component as unknown as { dispose(): void }).dispose();

    // The action reads down the column; the argument recedes behind it.
    const painted = createActivityGroupRenderer()(
      sequence,
      { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
      paintedTheme,
      context(),
    );
    if (!painted) throw new Error('renderer returned no component');
    const styled = painted.render(200).join('\n');
    expect(styled).toContain('<muted>Reading</muted>');
    expect(styled).toContain('<dim>src/commands/types.ts</dim>');
    // And a command is marked in its own colour, so the eye can find it.
    expect(styled).toContain('<accent>⏺</accent>');
    (painted as unknown as { dispose(): void }).dispose();
  });

  describe('titling a group with the preamble that announced it', () => {
    const titleOf = (text: string, streaming: boolean): string => {
      const component = createActivityGroupRenderer()(
        {
          id: 'sequence-6',
          cwd: process.cwd(),
          startedAt: 1000,
          failed: false,
          items: [
            {
              type: 'assistant',
              message: message([
                { type: 'thinking', thinking: '**Inspecting the store**' },
                { type: 'text', text },
                { type: 'toolCall', id: 'r1', name: 'read', arguments: {} },
              ]),
            },
            {
              type: 'tool',
              id: 'r1',
              name: 'read',
              args: { path: 'src/session.ts' },
              status: 'complete',
              isError: false,
            },
          ],
        },
        { streaming, expanded: false, defaultView: new Text('', 0, 0) },
        theme,
        context(),
      );
      if (!component) throw new Error('renderer returned no component');
      const [, title = ''] = component.render(100);
      (component as unknown as { dispose(): void }).dispose();
      return title;
    };

    it('prefers what the model said over the header it thought', () => {
      // And the emphasis inside it is styling, not something to print.
      expect(titleOf('Checking **how sessions expire**', true)).toContain(
        'Checking how sessions expire',
      );
      expect(titleOf('Checking **how sessions expire**', true)).not.toContain(
        'Inspecting the store',
      );
    });

    it('keeps the original preamble wording after the phase settles', () => {
      expect(titleOf('Checking how sessions expire', false)).toContain(
        '• Checking how sessions expire',
      );
    });

    it('keeps non-English preambles unchanged', () => {
      const preamble = 'Реализую поддержку русского';
      expect(titleOf(preamble, true)).toContain(preamble);
      expect(titleOf(preamble, false)).toContain(`• ${preamble}`);
    });

    it('keeps an action announced after the problem statement unchanged', () => {
      const preamble = "There's an issue here. Fixing it";
      expect(titleOf(preamble, true)).toContain(preamble);
      expect(titleOf(preamble, false)).toContain(`• ${preamble}`);
    });

    it('keeps a non-participle line exactly as written', () => {
      // A title is a label, so the full stop goes; the words do not.
      expect(titleOf("Now I'll check how sessions expire.", false)).toContain(
        "• Now I'll check how sessions expire",
      );
    });
  });

  describe('choosing between what a group said and what it thought', () => {
    const read: SequenceSnapshot['items'][number] = {
      type: 'tool',
      id: 'r1',
      name: 'read',
      args: { path: 'src/session.ts' },
      status: 'complete',
      isError: false,
    };

    const titleOf = (
      items: SequenceSnapshot['items'],
      streaming = false,
    ): string | undefined => {
      const component = createActivityGroupRenderer()(
        {
          id: 'sequence-7',
          cwd: process.cwd(),
          startedAt: 1000,
          completedAt: 2000,
          failed: false,
          items,
        },
        { streaming, expanded: false, defaultView: new Text('', 0, 0) },
        theme,
        context(),
      );
      if (!component) return undefined;
      const [, title = ''] = component.render(100);
      (component as unknown as { dispose(): void }).dispose();
      return title;
    };

    it('uses the paired visible preamble over thinking', () => {
      // Some models write their narration as text rather than in thinking, so
      // both channels carry a header and the thought comes first. Composing
      // the two led with the passing thought and buried the announcement.
      const items: SequenceSnapshot['items'] = [
        {
          type: 'assistant',
          message: message([
            { type: 'thinking', thinking: '**Creating a workspace**' },
            { type: 'text', text: 'Exercising **planning and cleanup**' },
            { type: 'toolCall', id: 'r1', name: 'read', arguments: {} },
          ]),
        },
        read,
      ];
      expect(titleOf(items, true)).toContain('Exercising planning and cleanup');
      expect(titleOf(items)).toContain('• Exercising planning and cleanup');
      expect(titleOf(items)).not.toContain('workspace');
    });

    it('opts out of a thinking-derived title', () => {
      expect(
        titleOf([
          {
            type: 'assistant',
            message: message([
              { type: 'thinking', thinking: '**Creating a workspace**' },
            ]),
          },
          read,
        ]),
      ).toBeUndefined();
    });

    it('opts out of a visible title without an associated tool call', () => {
      expect(
        titleOf([
          {
            type: 'assistant',
            message: message([
              { type: 'thinking', thinking: '**Planning the store rewrite**' },
            ]),
          },
          {
            type: 'assistant',
            message: message([
              { type: 'text', text: 'Rewriting how sessions expire' },
            ]),
          },
          read,
        ]),
      ).toBeUndefined();
    });

    it('opts out when a remark follows an unpaired thinking header', () => {
      expect(
        titleOf([
          {
            type: 'assistant',
            message: message([
              { type: 'thinking', thinking: '**Reading the session store**' },
            ]),
          },
          read,
          {
            type: 'assistant',
            message: message([
              { type: 'text', text: 'That confirms the token never expires' },
            ]),
          },
        ]),
      ).toBeUndefined();
    });
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
          preambleItem('Replaying the authentication check'),
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

  it('warns only when the final completed call failed', () => {
    const failed = toolItem(
      'ticket-1',
      'bash',
      { command: './mg/mg ticket BTB-2178' },
      true,
    );
    const succeeded = toolItem(
      'ticket-2',
      'bash',
      { command: 'mg ticket BTB-2178' },
      false,
    );

    expect(renderOutcome([failed, succeeded])).toContain('•');
    expect(renderOutcome([failed, succeeded])).toContain('1 failed');
    expect(renderOutcome([succeeded, failed])).toContain('!');
  });

  it('keeps the historical lint failure after an edit retry resolves it', () => {
    const output = renderOutcome([
      toolItem('lint-1', 'bash', { command: 'npm run lint' }, true),
      toolItem('edit-1', 'edit', { path: 'src/index.ts' }, false),
      toolItem('lint-2', 'bash', { command: 'npm run lint' }, false),
    ]);
    expect(output).toContain('•');
    expect(output).toContain('1 failed');
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
          preambleItem('Exploring missing.ts'),
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
    expect(output).toContain('! Exploring missing.ts');
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
              thinking: '**Planning the delegate shutdown fix**',
            },
            { type: 'text', text: 'Planning the delegate shutdown fix' },
            { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} },
          ]),
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
                'some prose\n\n**Implementing the shutdown guard**\n\nmore prose',
            },
          ]),
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
    // Live and settled titles stay on the explicit preamble, not later thought.
    expect(component.render(100).join('\n')).toContain(
      'Planning the delegate shutdown fix',
    );

    renderer(
      { ...sequence, completedAt: 4000 },
      { streaming: false, expanded: false, defaultView: new Text('', 0, 0) },
      theme,
      ctx,
    );
    const settled = component.render(100).join('\n');
    // Settled groups keep the explicit preamble rather than later narration.
    expect(settled).toContain('Planning the delegate shutdown fix');
    // Few enough calls to show them all, so nothing is counted away.
    expect(settled).toContain('Reading extensions/delegate/jobs.ts');
    expect(settled).not.toContain('earlier step');
    // The shared directory locates the group at a glance.
    expect(settled).toContain('2 files in extensions/delegate');
    (component as unknown as { dispose(): void }).dispose();
  });
});
