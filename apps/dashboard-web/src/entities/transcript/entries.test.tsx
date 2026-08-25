import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptModelItem } from '../../transcript';
import { TranscriptEntry } from './entries';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

describe('transcript entries', () => {
  it('renders unresolved live assistant text in full instead of a preparing event', () => {
    const item: TranscriptModelItem = {
      key: 'assistant-live',
      raw: {},
      entry: { kind: 'assistant', speaks: true, streaming: true },
      role: 'assistant',
      text: 'Editing the shutdown path.\n\nThis needs a guarded cleanup.',
      preparing: true,
    };

    const markup = renderToStaticMarkup(<TranscriptEntry item={item} />);

    expect(markup).toContain('message-bubble message-assistant');
    expect(markup).toContain('Editing the shutdown path.');
    expect(markup).toContain('This needs a guarded cleanup.');
    expect(markup).not.toContain('preparing-toolcall');
    expect(markup).not.toContain('preparing tool call');
  });

  it('copies the raw assistant Markdown and confirms the action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const text = '**Copied heading**\n\n- first\n- second';
    const item: TranscriptModelItem = {
      key: 'assistant-copy',
      raw: {},
      entry: { kind: 'assistant', speaks: true },
      role: 'assistant',
      text,
    };
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TranscriptEntry item={item} />);
    });
    const button = tree.root.findByProps({
      'aria-label': 'Copy assistant message',
    });
    await act(async () => button.props.onClick());

    expect(writeText).toHaveBeenCalledWith(text);
    expect(
      tree.root.findByProps({ 'aria-label': 'Copied assistant message' }),
    ).toBeDefined();
    act(() => tree.unmount());
  });

  it('renders compact colored line metrics for edit tools', () => {
    const item: TranscriptModelItem = {
      key: 'tool:edit-call',
      raw: {},
      entry: {
        kind: 'tool',
        name: 'edit',
        args: {},
        status: 'success',
      },
      tool: {
        kind: 'tool',
        key: 'tool:edit-call',
        toolCallId: 'edit-call',
        name: 'edit',
        arguments: {
          path: 'src/App.tsx',
          edits: [
            {
              oldText: 'old one\nold two',
              newText: 'new one\nnew two\nnew three',
            },
            { oldText: 'remove me', newText: '' },
          ],
        },
        status: 'success',
      },
    };

    const markup = renderToStaticMarkup(<TranscriptEntry item={item} />);

    expect(markup).toContain('class="activity-tool-argument-text"');
    expect(markup).toContain('class="line-change-added">+1</span>');
    expect(markup).toContain('class="line-change-changed">~2</span>');
    expect(markup).toContain('class="line-change-removed">-1</span>');
    expect(markup).not.toContain(' added</span>');
    expect(markup).not.toContain(' changed</span>');
    expect(markup).not.toContain(' removed</span>');
  });

  it('shows an error marker for failed tool calls', () => {
    const item: TranscriptModelItem = {
      key: 'tool:error-call',
      raw: {},
      entry: {
        kind: 'tool',
        name: 'bash',
        args: { command: 'false' },
        status: 'error',
        isError: true,
      },
      tool: {
        kind: 'tool',
        key: 'tool:error-call',
        toolCallId: 'error-call',
        name: 'bash',
        arguments: { command: 'false' },
        result: 'Command failed',
        status: 'error',
        isError: true,
      },
    };

    const markup = renderToStaticMarkup(<TranscriptEntry item={item} />);

    expect(markup).toContain('tool-detail role-command step-failed');
    expect(markup).toContain(
      '<span class="activity-step-dot" aria-hidden="true">!</span>',
    );
  });
});
