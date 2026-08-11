import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BoundedPayloadPreview,
  boundedInspectorText,
  ToolInspector,
} from './inspector';

describe('transcript payload inspection', () => {
  it('marks bounded previews and offers the complete value', () => {
    const value = { output: 'x'.repeat(14_000) };
    const markup = renderToStaticMarkup(
      <BoundedPayloadPreview value={value} label="raw payload" />,
    );
    expect(markup).toContain('Preview truncated after 12,000 characters.');
    expect(markup).toContain('Copy full raw payload');
    expect(markup).not.toContain('x'.repeat(14_000));
  });

  it('keeps the compact inspector text contract while tracking deep bounds', () => {
    expect(
      boundedInspectorText({ nested: { value: { deep: 'hidden' } } }),
    ).toBe('{ nested: { value: { deep: … } } }');
    const markup = renderToStaticMarkup(
      <ToolInspector tool={{ arguments: 'x'.repeat(1_300) }} />,
    );
    expect(markup).toContain('Preview truncated');
    expect(markup).toContain('Copy full arguments');
    expect(markup).toContain('Raw payload');
  });
});
