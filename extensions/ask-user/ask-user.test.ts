import { initTheme } from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
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

    renderMarkdown.mockClear();
    dialog().render(120);
    expect(renderMarkdown).not.toHaveBeenCalled();
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
    execute: (...args: unknown[]) => Promise<{
      details: { answer: string | null; cancelled: boolean };
    }>;
  };

  function registeredTool(): RegisteredTool {
    const tools: RegisteredTool[] = [];
    askUser({
      registerTool(value: unknown) {
        tools.push(value as RegisteredTool);
      },
    } as never);
    const tool = tools[0];
    if (!tool) throw new Error('ask-user tool was not registered');
    return tool;
  }

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
