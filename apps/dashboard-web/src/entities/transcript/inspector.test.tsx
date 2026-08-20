import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { commandStepMeta } from './activity';
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
    expect(write).toContain('tool-code-line-added');
    expect(write).toContain('tool-code-prefix');
    expect(write).not.toContain('Write · src/app.ts');
    expect(write).not.toContain('Newly written content · additions only');
    expect(write).not.toContain('<h4>');
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
    expect(edit.match(/>Replacement [12]<\/h5>/gu)).toBeNull();
    expect(edit).toContain('aria-label="Edit replacement 1"');
    expect(edit).toContain('aria-label="Edit replacement 2"');
    expect(edit).not.toContain(
      'Replacement preview; this is not a repository or full-file diff.',
    );
    expect(edit).not.toContain('<h4>');
    expect(edit).toContain('tool-code-line-removed');
    expect(edit).toContain('tool-code-line-added');
    expect(edit).toContain('class="sr-only">Removed line: </span>');
    expect(edit).toContain('class="sr-only">Added line: </span>');
    const contextEdit = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'edit',
          arguments: {
            path: 'src/app.ts',
            edits: [{ oldText: 'keep\nremove()', newText: 'keep\ninsert()' }],
          },
        }}
      />,
    );
    expect(contextEdit).toContain('class="sr-only">Context line: </span>');

    const duplicateEdit = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'edit',
          arguments: {
            path: 'src/app.ts',
            edits: [
              { oldText: 'same', newText: 'replacement' },
              { oldText: 'same', newText: 'replacement' },
            ],
          },
        }}
      />,
    );
    expect(duplicateEdit.match(/>Replacement [12]<\/h5>/gu)).toBeNull();
    expect(
      duplicateEdit.match(/aria-label="Edit replacement [12]"/gu),
    ).toHaveLength(2);
  });

  it('falls back to generic JSON for malformed or over-cap edit lists', () => {
    const mixedMalformed = {
      name: 'edit',
      arguments: {
        path: 'src/app.ts',
        edits: [{ oldText: 'a', newText: 'b' }, ['not-an-edit']],
      },
    };
    expect(toolPresentationKind(mixedMalformed)).toBeUndefined();
    const malformedMarkup = renderToStaticMarkup(
      <ToolInspector tool={mixedMalformed} />,
    );
    expect(malformedMarkup).toContain('Arguments');
    expect(malformedMarkup).not.toContain('Replacement preview · src/app.ts');

    const overCap = {
      name: 'edit',
      arguments: {
        path: 'src/app.ts',
        edits: Array.from({ length: 25 }, (_, index) => ({
          oldText: `old-${index}`,
          newText: `new-${index}`,
        })),
      },
    };
    expect(toolPresentationKind(overCap)).toBeUndefined();
    const overCapMarkup = renderToStaticMarkup(
      <ToolInspector tool={overCap} />,
    );
    expect(overCapMarkup).toContain('Arguments');
    expect(overCapMarkup).not.toContain('Replacement 1');
  });

  it('renders empty writes as an explicit empty preview', () => {
    const markup = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'write',
          arguments: { path: 'src/empty.ts', content: '' },
        }}
      />,
    );
    expect(markup).toContain('No content');
    expect(markup).not.toContain('tool-code-line-added');
  });

  it('highlights meaningful bash syntax and keeps the command body padded', () => {
    const markup = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'bash',
          arguments: {
            command:
              'ROOT="src"; pnpm run check --filter "$ROOT" | tee out.txt $(printf %s "$ROOT") # inspect',
          },
        }}
      />,
    );
    expect(markup).toContain('tool-command-preview');
    expect(markup).toContain('hljs-string');
    expect(markup).toContain('hljs-variable');
    expect(markup).toContain('hljs-built_in');
    expect(markup).toContain('hljs-comment');
    expect(markup).not.toContain('<h4>Command</h4>');
    expect(markup).not.toContain('<h4>Terminal result</h4>');
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
    expect(normalizeToolResultText({ content: { content: 'nested' } })).toBe(
      'nested',
    );
    expect(normalizeToolResultText({ content: 'x'.repeat(12_001) })).toBe(
      'x'.repeat(12_000),
    );
    expect(
      normalizeToolResultText(
        Array.from({ length: 129 }, () => ({ type: 'text', text: 'x' })),
      ),
    ).toBeUndefined();
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
    expect(command).toContain('aria-label="Command"');
    expect(command).toContain('aria-label="Terminal result"');
    expect(command).toContain('failed output');
    expect(command).not.toContain('Status: error');
    expect(command).toContain('exit 2');
    expect(command).not.toContain('<h4>Command</h4>');
    expect(command).not.toContain('<h4>Terminal result</h4>');
    expect(command).toContain('tool-terminal-result-error');
    expect(command).toContain('Raw Arguments');
    expect(command).toContain('Raw Result');
  });

  it('keeps full specialized arguments while bounding only command results', () => {
    const longCommand = `printf '${'x'.repeat(12_001)}'`;
    const markup = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'bash',
          arguments: { command: longCommand },
          result: 'z'.repeat(12_001),
          data: { argumentsTruncated: true, resultTruncated: true },
        }}
      />,
    );
    expect(markup).toContain('x'.repeat(12_001));
    expect(markup).not.toContain(
      'Arguments preview is truncated after 12,000 characters',
    );
    expect(markup).toContain(
      'Result preview is truncated after 12,000 characters',
    );
    expect(markup).not.toContain('z'.repeat(12_001));
    expect(markup).toContain(
      'Source truncated this arguments before it reached the dashboard.',
    );
    expect(markup).toContain(
      'Source truncated this result before it reached the dashboard.',
    );
  });

  it('preserves result source-truncation disclosure on write and edit presentations', () => {
    const write = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'write',
          arguments: { path: 'src/app.ts', content: 'const ready = true;' },
          data: { resultTruncated: true },
        }}
      />,
    );
    const edit = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'edit',
          arguments: {
            path: 'src/app.ts',
            edits: [{ oldText: 'old', newText: 'new' }],
          },
          data: { resultTruncated: true },
        }}
      />,
    );
    const notice =
      'Source truncated this result before it reached the dashboard.';
    expect(write).toContain(notice);
    expect(edit).toContain(notice);
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
    expect(markup).toContain('tool-code-line-added');
    expect(markup).toContain('x'.repeat(12_001));
    expect(markup).not.toContain(
      'preview is truncated after 12,000 characters',
    );
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

  it('renders read, grep, and delete specialized previews', () => {
    expect(
      toolPresentationKind({
        name: 'read',
        arguments: { path: 'src/app.ts' },
      }),
    ).toBe('read');
    expect(
      toolPresentationKind({
        name: 'grep',
        arguments: { pattern: 'TODO' },
      }),
    ).toBe('grep');
    expect(
      toolPresentationKind({
        name: 'delete',
        arguments: { path: 'tmp/old.ts' },
      }),
    ).toBe('delete');
    expect(
      toolPresentationKind({
        name: 'mcp_server_search',
        arguments: { query: 'docs' },
      }),
    ).toBeUndefined();

    const read = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'read',
          arguments: { path: 'src/app.ts' },
          result: 'const ready = true;\n',
        }}
      />,
    );
    expect(read).toContain('tool-read-presentation');
    expect(read).toContain('app.ts');
    expect(read).toContain('1 line');

    const grep = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'grep',
          arguments: { pattern: 'TODO' },
          result: 'src/a.ts:1:TODO\nsrc/b.ts:4:TODO',
        }}
      />,
    );
    expect(grep).toContain('tool-grep-presentation');
    expect(grep).toContain('TODO');
    expect(grep).toContain('2 matches');

    const deleted = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'delete',
          arguments: { path: 'tmp/old.ts' },
        }}
      />,
    );
    expect(deleted).toContain('tool-delete-presentation');
    expect(deleted).toContain('tmp/old.ts');
  });

  it('renders custom extension tools instead of generic JSON', () => {
    expect(
      toolPresentationKind({
        name: 'web_search',
        arguments: { query: 'activity model' },
      }),
    ).toBe('web_search');
    expect(
      toolPresentationKind({
        name: 'fetch_content',
        arguments: { url: 'https://example.com' },
      }),
    ).toBe('fetch_content');
    expect(toolPresentationKind({ name: 'get_search_content' })).toBe(
      'get_search_content',
    );
    expect(toolPresentationKind({ name: 'artifact_retrieve' })).toBe(
      'artifact_retrieve',
    );
    expect(toolPresentationKind({ name: 'delegate' })).toBe('delegate');
    expect(toolPresentationKind({ name: 'delegate_jobs' })).toBe(
      'delegate_jobs',
    );
    expect(toolPresentationKind({ name: 'delegate_branches' })).toBe(
      'delegate_branches',
    );
    expect(toolPresentationKind({ name: 'delegate_wake' })).toBe(
      'delegate_wake',
    );
    expect(toolPresentationKind({ name: 'background' })).toBe('background');
    expect(toolPresentationKind({ name: 'todo' })).toBe('todo');
    const search = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'web_search',
          arguments: { queries: ['one', 'two'], recencyFilter: 'week' },
          result: '## Hits\n\n- example',
        }}
      />,
    );
    expect(search).toContain('tool-web_search-presentation');
    expect(search).toContain('2 queries');
    expect(search).toContain('<h2>Hits</h2>');
    expect(search).toContain('Raw Arguments');

    const delegate = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'delegate',
          arguments: {
            name: 'Review worker',
            route: 'quick',
            task: 'Inspect the queue',
          },
          result: 'Queued Review worker.',
        }}
      />,
    );
    expect(delegate).toContain('tool-delegate-presentation');
    expect(delegate).toContain('Review worker');
    expect(delegate).toContain('Inspect the queue');

    const background = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'background',
          arguments: {
            action: 'start',
            title: 'dev',
            command: 'pnpm dev',
          },
        }}
      />,
    );
    expect(background).toContain('tool-background-presentation');
    expect(background).toContain('pnpm dev');

    const tasks = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'todo',
          arguments: {
            action: 'done',
            id: 'H4',
            notes:
              'Focused coordinator suite (43 tests), Biome, root typecheck, and full pnpm run check passed.',
          },
          result: 'done H4',
        }}
      />,
    );
    expect(tasks).toContain('tool-todo-presentation');
    expect(tasks).toContain('Focused coordinator suite');
    expect(tasks).toContain('done · H4');
    expect(tasks).not.toContain('tool-custom-output');

    const listed = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'todo',
          arguments: { action: 'list' },
          result: 'H4 [done] Focused coordinator suite',
        }}
      />,
    );
    expect(listed).toContain('tool-custom-output');
    expect(listed).toContain('H4 [done] Focused coordinator suite');

    const batched = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'todo',
          arguments: {
            action: 'batch',
            operations: [
              {
                action: 'done',
                id: 'H4',
                notes: 'Focused coordinator suite passed.',
              },
              {
                action: 'start',
                id: 'H5',
                text: 'Ship the dashboard presenters',
              },
            ],
          },
          result: 'done H4; start H5',
        }}
      />,
    );
    expect(batched).toContain('2 operations');
    expect(batched).toContain('done · H4');
    expect(batched).toContain('Focused coordinator suite passed.');
    expect(batched).toContain('start · H5');
    expect(batched).toContain('Ship the dashboard presenters');
    expect(batched).not.toContain('tool-custom-output');

    const replaced = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'todo',
          arguments: {
            action: 'replace',
            tasks: [
              {
                id: 'H4',
                text: 'Ship presenters',
                status: 'doing',
                notes: 'Dashboard inspectors',
                depends_on: ['H3'],
              },
              { id: 'H5', text: 'Follow-up review' },
            ],
          },
          result: 'replaced with 2 tasks',
        }}
      />,
    );
    expect(replaced).toContain('2 tasks');
    expect(replaced).toContain('H4 · doing');
    expect(replaced).toContain('Ship presenters');
    expect(replaced).toContain('Dashboard inspectors');
    expect(replaced).toContain('depends on H3');
    expect(replaced).toContain('Follow-up review');
    expect(replaced).not.toContain('tool-custom-output');

    const branches = renderToStaticMarkup(
      <ToolInspector
        tool={{
          name: 'delegate_branches',
          arguments: {
            action: 'review',
            id: 'wt-1',
            incremental: true,
            paths: ['src/a.ts', 'src/b.ts'],
          },
          result:
            'pi/wt-1 (unmerged), incremental task delta\n\ndiff --git a/src/a.ts',
        }}
      />,
    );
    expect(branches).toContain('tool-delegate_branches-presentation');
    expect(branches).toContain('incremental');
    expect(branches).toContain('src/a.ts');
    expect(branches).toContain('2 paths');
  });

  it('formats command exit code and duration for collapsed step meta', () => {
    expect(
      commandStepMeta({
        name: 'bash',
        args: { command: 'pnpm test' },
        result: { exitCode: 1, durationMs: 2500 },
      }),
    ).toBe('exit 1 · 3s');
    expect(
      commandStepMeta({
        name: 'read',
        args: { path: 'src/app.ts' },
        result: { exitCode: 0 },
      }),
    ).toBeUndefined();
  });
});
