import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BoundedPayloadPreview,
  boundedInspectorText,
  StructuredPayloadView,
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

  it('renders structured values as a semantic collapsible document rather than a table', () => {
    const markup = renderToStaticMarkup(
      <StructuredPayloadView
        value={{
          outcome: 'done',
          findings: [{ filePath: 'src/App.tsx', lineCount: 42 }],
          checkList: ['types', 'tests'],
        }}
      />,
    );
    expect(markup).toContain('class="structured-result-value"');
    expect(markup).not.toContain('aria-level=');
    expect(markup).not.toContain('role="heading"');
    expect(markup).toContain('>Payload</span>');
    expect(markup).toContain('object · 3 fields');
    expect(markup).toContain('>Outcome</strong>');
    expect(markup).toContain('>Findings</span>');
    expect(markup).toContain('array · 1 item');
    expect(markup).toContain('>File path</strong>');
    expect(markup).toContain('src/App.tsx');
    expect(markup).toContain('<ol class="structured-result-list">');
    expect(markup).toContain('types');
    expect(markup).not.toContain('<dl');
    expect(markup).not.toContain('<dt');
    expect(markup).not.toContain('<pre>');
    expect(markup).not.toContain('&quot;outcome&quot;');
  });

  it('keeps depth, entry, and string bounds visible to readers', () => {
    const deeplyNested = {
      levelOne: {
        levelTwo: {
          levelThree: {
            levelFour: {
              hidden: { value: 'not rendered' },
            },
          },
        },
      },
      longText: 'x'.repeat(1_201),
      fields: Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [`field${index}`, index]),
      ),
    };
    const markup = renderToStaticMarkup(
      <StructuredPayloadView value={deeplyNested} />,
    );
    expect(markup).toContain(
      'Nested content omitted after depth 4. Open the raw JSON fallback for the complete bounded value.',
    );
    expect(markup).toContain(
      'String truncated after 1,200 characters; remaining characters are not displayed.',
    );
    expect(markup).toContain('Showing 24 of 25 fields; 1 field omitted.');
    expect(markup).toContain('class="structured-result-node"');
    expect(markup).not.toContain('not rendered');
  });

  it('renders cyclic object and array payloads with bounded raw fallback', () => {
    const cycle: { items?: unknown[] } = {};
    const items: unknown[] = [cycle];
    cycle.items = items;
    let markup = '';
    expect(() => {
      markup = renderToStaticMarkup(<StructuredPayloadView value={cycle} />);
    }).not.toThrow();
    expect(markup).toContain('Nested content omitted after depth 4.');
    const rawMarkup = renderToStaticMarkup(
      <BoundedPayloadPreview value={cycle} label="cyclic payload" />,
    );
    expect(rawMarkup).toContain('[unavailable payload]');
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
