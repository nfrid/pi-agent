import { initTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import askUser from './index';
import { createQuestionDialog } from './ui';

initTheme('dark', false);

const theme = {
  fg: (_color: string, text: string) => text,
};

afterEach(() => vi.restoreAllMocks());

function dialog(preview?: string) {
  return createQuestionDialog(
    { question: 'Choose one' },
    [{ label: 'Option', value: 'option', preview }],
    { requestRender: vi.fn() } as never,
    theme as never,
    vi.fn(),
  );
}

describe('ask-user UI', () => {
  it('renders a wide selected preview once and reuses the render cache', () => {
    const renderMarkdown = vi.spyOn(Markdown.prototype, 'render');
    const question = dialog('## Preview\n\nDetails');

    const first = question.render(120);
    const second = question.render(120);

    expect(first.join('\n')).toContain('Preview');
    expect(second).toBe(first);
    expect(renderMarkdown).toHaveBeenCalledOnce();
  });

  it('renders narrow previews once and skips markdown when no preview exists', () => {
    const renderMarkdown = vi.spyOn(Markdown.prototype, 'render');

    expect(dialog('Preview text').render(80).join('\n')).toContain(
      'Preview text',
    );
    expect(renderMarkdown).toHaveBeenCalledOnce();

    const narrow = dialog('Preview text').render(2);
    expect(narrow.join('').replaceAll(/\s/g, '')).toContain('Previewtext');
    expect(narrow.every((line) => visibleWidth(line) <= 2)).toBe(true);

    renderMarkdown.mockClear();
    dialog().render(120);
    expect(renderMarkdown).not.toHaveBeenCalled();
  });

  it('wraps option labels and descriptions instead of truncating them', () => {
    const question = createQuestionDialog(
      { question: 'Choose one' },
      [
        {
          label: 'A deliberately detailed option label that stays readable',
          value: 'option',
          description:
            'Preserve this valuable explanation across every rendered line',
        },
      ],
      { requestRender: vi.fn() } as never,
      theme as never,
      vi.fn(),
    );

    const lines = question.render(32);
    const renderedText = lines.map((line) => line.trim()).join(' ');
    expect(renderedText).toContain(
      'A deliberately detailed option label that stays readable',
    );
    expect(renderedText).toContain(
      'Preserve this valuable explanation across every rendered line',
    );
    expect(lines.filter((line) => line.startsWith('     '))).toHaveLength(3);
    expect(lines).not.toContain(expect.stringContaining('…'));
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);

    const narrow = question.render(2);
    const narrowText = narrow.join('').replaceAll(/\s/g, '');
    expect(narrowText).toContain(
      '1.Adeliberatelydetailedoptionlabelthatstaysreadable',
    );
    expect(narrowText).toContain(
      'Preservethisvaluableexplanationacrosseveryrenderedline',
    );
    expect(narrow.every((line) => visibleWidth(line) <= 2)).toBe(true);
  });

  it('invalidates the cached preview when selection changes', () => {
    const renderMarkdown = vi.spyOn(Markdown.prototype, 'render');
    const question = createQuestionDialog(
      { question: 'Choose one' },
      [
        { label: 'One', value: 'one', preview: 'First preview' },
        { label: 'Two', value: 'two', preview: 'Second preview' },
      ],
      { requestRender: vi.fn() } as never,
      theme as never,
      vi.fn(),
    );

    expect(question.render(120).join('\n')).toContain('First preview');
    question.handleInput('\u001b[B');
    const changed = question.render(120).join('\n');

    expect(changed).toContain('Second preview');
    expect(changed).not.toContain('First preview');
    expect(renderMarkdown).toHaveBeenCalledTimes(2);
  });

  it('closes the local presenter when broker cancellation wins', () => {
    const done = vi.fn();
    const question = createQuestionDialog(
      { question: 'Choose one' },
      [{ label: 'Yes', value: 'yes' }],
      { requestRender: vi.fn() } as never,
      theme as never,
      done,
    );
    question.cancel();
    question.cancel();
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(null);
  });

  it('backs out of custom input before cancelling the question', () => {
    const done = vi.fn();
    const question = createQuestionDialog(
      { question: 'Choose one' },
      [{ label: 'Custom', value: '', custom: true }],
      { requestRender: vi.fn() } as never,
      theme as never,
      done,
    );

    question.handleInput('\r');
    question.handleInput('\u001b');
    expect(done).not.toHaveBeenCalled();

    question.handleInput('\u001b');
    expect(done).toHaveBeenCalledWith(null);
  });
});

describe('ask-user tool', () => {
  type RegisteredTool = {
    promptGuidelines?: string[];
    execute: (...args: unknown[]) => Promise<{
      details: { answer: string | null; cancelled: boolean };
    }>;
  };

  function registeredTools(hasUI: boolean): RegisteredTool[] {
    const tools: RegisteredTool[] = [];
    let onSessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
    askUser({
      on(event: string, handler: (event: unknown, ctx: unknown) => void) {
        if (event === 'session_start') onSessionStart = handler;
      },
      registerTool(value: unknown) {
        tools.push(value as RegisteredTool);
      },
    } as never);
    onSessionStart?.({}, { hasUI });
    return tools;
  }

  function registeredTool(): RegisteredTool {
    const tool = registeredTools(true)[0];
    if (!tool) throw new Error('ask-user tool was not registered');
    return tool;
  }

  it('loads human-owned ask policy as bullet guidelines', () => {
    expect(registeredTool().promptGuidelines).toEqual([
      'Ask only when the answer belongs to the user: a destructive or irreversible step, or a preference the repository cannot settle. Decide anything you can resolve yourself, state the assumption, and continue.',
      'When asking, ask once and narrowly: one concrete question with the likely answers as choices; include a choice preview when a short code or ASCII comparison would decide it.',
    ]);
  });

  it('stays out of the prompt when no interactive UI exists', () => {
    expect(registeredTools(false)).toHaveLength(0);
  });

  it('rejects non-interactive execution', async () => {
    const tool = registeredTool();
    await expect(
      tool.execute(
        'call',
        { question: 'Continue?' },
        new AbortController().signal,
        () => {},
        { mode: 'json' },
      ),
    ).rejects.toThrow('interactive TUI is not available');
  });

  it('collects an RPC answer through select, which the protocol supports', async () => {
    const tool = registeredTool();
    const select = vi.fn().mockResolvedValue('2. Rewrite it');
    const custom = vi.fn().mockResolvedValue(undefined);
    const result = await tool.execute(
      'call',
      {
        question: 'How should we proceed?',
        choices: [{ label: 'Patch it' }, { label: 'Rewrite it' }],
        allowCustom: false,
      },
      new AbortController().signal,
      () => {},
      { mode: 'rpc', ui: { select, input: vi.fn(), custom } },
    );

    // custom() silently resolves undefined in RPC, so reaching it at all would
    // report a cancellation the user never made.
    expect(custom).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith('How should we proceed?', [
      '1. Patch it',
      '2. Rewrite it',
    ]);
    expect(result.details).toMatchObject({
      answer: 'Rewrite it',
      choiceLabel: 'Rewrite it',
      choiceIndex: 2,
      cancelled: false,
    });
  });

  it('routes an RPC custom answer to the input dialog', async () => {
    const tool = registeredTool();
    const select = vi.fn().mockResolvedValue('2. Type something else');
    const input = vi.fn().mockResolvedValue('neither, revert');
    const result = await tool.execute(
      'call',
      { question: 'How should we proceed?', choices: [{ label: 'Patch it' }] },
      new AbortController().signal,
      () => {},
      { mode: 'rpc', ui: { select, input, custom: vi.fn() } },
    );

    expect(input).toHaveBeenCalled();
    expect(result.details).toMatchObject({
      answer: 'neither, revert',
      custom: true,
      cancelled: false,
    });
  });

  it('reports an RPC cancellation only when the user dismissed the dialog', async () => {
    const tool = registeredTool();
    const result = await tool.execute(
      'call',
      { question: 'Continue?' },
      new AbortController().signal,
      () => {},
      {
        mode: 'rpc',
        ui: {
          select: vi.fn(),
          input: vi.fn().mockResolvedValue(undefined),
          custom: vi.fn(),
        },
      },
    );

    expect(result.details).toMatchObject({ answer: null, cancelled: true });
  });

  it('returns a cancelled result when the dialog closes without an answer', async () => {
    const tool = registeredTool();
    const result = await tool.execute(
      'call',
      { question: 'Continue?' },
      new AbortController().signal,
      () => {},
      { mode: 'tui', ui: { custom: vi.fn().mockResolvedValue(null) } },
    );

    expect(result.details).toMatchObject({ answer: null, cancelled: true });
  });
});
