import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

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

  it('does not enable raw HTML and opens links without opener access', () => {
    const html = renderToStaticMarkup(
      <Markdown>{`<script>alert('no')</script>\n\n[docs](https://example.com)`}</Markdown>,
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});
