import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TranscriptModelItem } from '../../transcript';
import { TranscriptEntry } from './entries';

describe('expanded transcript tool rows', () => {
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
