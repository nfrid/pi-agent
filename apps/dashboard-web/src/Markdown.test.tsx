import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

describe('Markdown', () => {
  it('renders common response and user-message Markdown', () => {
    const html = renderToStaticMarkup(
      <Markdown>{`**bold** and \`code\`\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |`}</Markdown>,
    );

    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<table>');
  });

  it('copies fenced code without the Markdown trailing newline', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<Markdown>{'```ts\nconst ready = true;\n```'}</Markdown>);
    });
    const button = tree.root.findByProps({ 'aria-label': 'Copy code block' });
    await act(async () => button.props.onClick());

    expect(writeText).toHaveBeenCalledWith('const ready = true;');
    expect(
      tree.root.findByProps({ 'aria-label': 'Copied code block' }),
    ).toBeDefined();
    act(() => tree.unmount());
  });

  it('does not add a copy button to inline code', () => {
    const html = renderToStaticMarkup(<Markdown>{'Use `bun test`.'}</Markdown>);

    expect(html).not.toContain('Copy code block');
  });

  it('does not enable raw HTML and opens links without opener access', () => {
    const html = renderToStaticMarkup(
      <Markdown>{`<script>alert('no')</script>\n\n[docs](https://example.com)`}</Markdown>,
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});
