import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BoundedPayloadPreview,
  boundedInspectorText,
  ToolInspector,
} from './inspector';

describe('transcript payload inspection', () => {
  it('marks bounded previews without making copy the primary interaction', () => {
    const value = { output: 'x'.repeat(14_000) };
    const markup = renderToStaticMarkup(
      <BoundedPayloadPreview value={value} label="raw payload" />,
    );
    expect(markup).toContain(
      'raw payload is truncated after 12,000 characters.',
    );
    expect(markup).not.toContain('Copy full raw payload');
    expect(markup).not.toContain('x'.repeat(14_000));
  });

  it('keeps the compact inspector text contract while tracking deep bounds', () => {
    expect(
      boundedInspectorText({ nested: { value: { deep: 'hidden' } } }),
    ).toBe('{ nested: { value: { deep: … } } }');
    const markup = renderToStaticMarkup(
      <ToolInspector tool={{ arguments: 'x'.repeat(14_000) }} />,
    );
    expect(markup).toContain('arguments is truncated after 12,000 characters.');
    expect(markup).toContain('Arguments');
    expect(markup).toContain('Raw tool record');
    expect(markup).not.toContain('Copy full arguments');
  });

  it('separates arguments and result before the expandable raw fallback', () => {
    const markup = renderToStaticMarkup(
      <ToolInspector
        tool={{
          status: 'success',
          arguments: { path: 'src/App.tsx' },
          result: { lines: 42 },
          data: { argumentsTruncated: true, resultTruncated: true },
        }}
      />,
    );
    expect(markup.indexOf('Arguments')).toBeLessThan(markup.indexOf('Result'));
    expect(markup.indexOf('Result')).toBeLessThan(
      markup.indexOf('Raw tool record'),
    );
    expect(markup).toContain('src/App.tsx');
    expect(markup).toContain('&quot;lines&quot;: 42');
    expect(markup).toContain(
      'Source truncated this arguments before it reached the dashboard.',
    );
    expect(markup).toContain(
      'Source truncated this result before it reached the dashboard.',
    );
  });
});
