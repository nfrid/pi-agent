import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BoundedPayloadPreview,
  boundedInspectorText,
  normalizeToolResultText,
  StructuredPayloadView,
  ToolInspector,
  toolPresentationKind,
  toolPreviewLanguage,
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
    expect(markup).toContain('<div class="structured-result-list">');
    expect(markup).toContain('>Item 1</strong>');
    expect(markup).toContain('types');
    expect(markup).not.toContain('<dl');
    expect(markup).not.toContain('<dt');
    expect(markup).not.toContain('<pre>');
    expect(markup).not.toContain('&quot;outcome&quot;');
  });

  it('renders string values through Markdown while keeping primitive paragraphs readable', () => {
    const markup = renderToStaticMarkup(
      <StructuredPayloadView
        value={{
          notes:
            '## Notes\n\n- [dashboard](https://example.com)\n- use `code`\n\n```ts\nconst ready = true;\n```',
          count: 2,
          enabled: true,
        }}
      />,
    );
    expect(markup).toMatch(/class="markdown(?: |")/u);
    expect(markup).toContain('<h2>Notes</h2>');
    expect(markup).toContain(
      '<a href="https://example.com" target="_blank" rel="noreferrer noopener">dashboard</a>',
    );
    expect(markup).toContain('<li>');
    expect(markup).toContain('<code>code</code>');
    expect(markup).toContain(
      '<pre><code class="language-ts">const ready = true;\n</code></pre>',
    );
    expect(markup).toContain('<p class="structured-result-primitive">2</p>');
    expect(markup).toContain('<p class="structured-result-primitive">true</p>');
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

  it('selects specialized tools only for valid payloads and preserves malformed fallback', () => {
    expect(
      toolPresentationKind({
        name: 'write',
        arguments: { path: 'src/app.ts', content: 'const ready = true;' },
      }),
    ).toBe('write');
    expect(
      toolPresentationKind({
        name: 'edit',
        arguments: {
          path: 'src/app.ts',
          edits: [{ oldText: 'a', newText: 'b' }],
        },
      }),
    ).toBe('edit');
    expect(
      toolPresentationKind({
        name: 'bash',
        arguments: { command: 'printf ok' },
      }),
    ).toBe('command');
    expect(toolPreviewLanguage('src/app.ts')).toBe('typescript');
    expect(toolPreviewLanguage('src/app.unknown')).toBe('plaintext');
    expect(
      toolPresentationKind({
        name: 'edit',
        arguments: { path: 'src/app.ts', edits: [{ oldText: 'missing' }] },
      }),
    ).toBeUndefined();
    const fallback = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'edit',
          arguments: { path: 'app.ts', edits: [{ oldText: 1 }] },
        }}
      />,
    );
    expect(fallback).toContain('Arguments');
    expect(fallback).toContain('Raw tool record');
  });

  it('renders write additions and one maintained diff preview per edit replacement', () => {
    const write = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'write',
          arguments: { path: 'src/app.ts', content: 'const ready = true;\n' },
        }}
      />,
    );
    expect(write).toContain('Write · src/app.ts');
    expect(write).toContain('Newly written content · additions only');
    expect(write).toContain('tool-code-line-added');
    expect(write).toContain('tool-code-prefix');
    expect(write).not.toContain('full-file diff');

    const edit = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'edit',
          arguments: {
            path: 'src/app.ts',
            edits: [
              { oldText: 'const a = 1;', newText: 'const a = 2;' },
              { oldText: 'remove()', newText: 'insert()' },
            ],
          },
        }}
      />,
    );
    expect(edit.match(/>Replacement [12]<\/h5>/gu)).toHaveLength(2);
    expect(edit).toContain(
      'Replacement preview; this is not a repository or full-file diff.',
    );
    expect(edit).toContain('tool-code-line-removed');
    expect(edit).toContain('tool-code-line-added');
  });

  it('normalizes only supported result text shapes and presents command errors as terminal output', () => {
    expect(normalizeToolResultText('plain output')).toBe('plain output');
    expect(
      normalizeToolResultText([
        { type: 'text', text: 'first' },
        { type: 'text', text: ' second' },
      ]),
    ).toBe('first second');
    expect(
      normalizeToolResultText({ content: [{ type: 'text', text: 'nested' }] }),
    ).toBe('nested');
    expect(normalizeToolResultText({ output: 'do not guess' })).toBeUndefined();
    const command = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'exec',
          arguments: { command: 'pnpm test' },
          result: {
            content: [{ type: 'text', text: 'failed output' }],
            exitCode: 2,
          },
          status: 'error',
          isError: true,
        }}
      />,
    );
    expect(command).toContain('Command');
    expect(command).toContain('Terminal result');
    expect(command).toContain('failed output');
    expect(command).toContain('Status: error');
    expect(command).toContain('Exit code: 2');
    expect(command).toContain('tool-terminal-result-error');
    expect(command).toContain('Raw Arguments');
    expect(command).toContain('Raw Result');
  });

  it('uses plaintext for unknown extensions and keeps preview/source truncation truthful', () => {
    const longContent = 'x'.repeat(12_001);
    const markup = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'write',
          arguments: { path: 'src/app.unknown', content: longContent },
          data: { argumentsTruncated: true },
        }}
      />,
    );
    expect(markup).toContain('Newly written content');
    expect(markup).toContain('preview is truncated after 12,000 characters');
    expect(markup).toContain(
      'Source truncated this arguments before it reached the dashboard.',
    );
    expect(markup).toContain('Raw Arguments');
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
