import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  groupCodemodeCalls,
  type TranscriptModelItem,
  toTranscriptEntries,
} from '../../transcript';
import {
  CodemodeOutput,
  CodemodeScript,
  codemodeCallSummary,
} from './codemode';
import { TranscriptEntry } from './entries';
import { transcriptItemTimestamp } from './landmarks';

function call(
  id: string,
  name: string,
  parentToolCallId?: string,
  status: NonNullable<TranscriptModelItem['tool']>['status'] = 'success',
): TranscriptModelItem {
  return {
    key: id,
    raw: {},
    entry: { kind: 'tool', name, args: {} },
    tool: {
      kind: 'tool',
      key: id,
      toolCallId: id,
      name,
      status,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    },
  };
}

describe('codemode presentation', () => {
  it('keeps descendants in projection order and annotates codemode ancestry without mutating inputs', () => {
    const root = call('root', 'codemode');
    const child = call('root/1', 'bash', 'root');
    const items = [
      root,
      child,
      call('direct', 'read'),
      call('root/1/1', 'read', 'root/1'),
      call('second', 'codemode'),
      call('second/1', 'todo_list', 'second'),
    ];
    const grouped = groupCodemodeCalls(items);
    expect(grouped.map((item) => item.key)).toEqual([
      'root',
      'root/1',
      'direct',
      'root/1/1',
      'second',
      'second/1',
    ]);
    expect(grouped[0]?.codemodeDescendants?.map((item) => item.key)).toEqual([
      'root/1',
      'root/1/1',
    ]);
    expect(grouped[1]?.codemodeRootKey).toBe('root');
    expect(grouped[3]?.codemodeRootKey).toBe('root');
    expect(grouped[4]?.codemodeDescendants?.map((item) => item.key)).toEqual([
      'second/1',
    ]);
    expect(root).not.toHaveProperty('codemodeDescendants');
    expect(child).not.toHaveProperty('codemodeRootKey');
  });

  it('summarizes known running/failed calls and bounds the tool name list without guessing progress', () => {
    expect(
      codemodeCallSummary([
        call('a', 'read'),
        call('b', 'read', undefined, 'running'),
        call('c', 'bash', undefined, 'error'),
        call('d', 'web_search', undefined, 'pending'),
        call('e', 'todo_list'),
      ]),
    ).toBe('2 running · 1 failed · read, bash, web_search · +1 more');
    expect(codemodeCallSummary([])).toBe('');
  });

  it('keeps orphan, cyclic, and non-codemode nested calls visible without assigning provenance', () => {
    const items = [
      call('orphan', 'read', 'absent'),
      call('a', 'codemode', 'b'),
      call('b', 'codemode', 'a'),
      call('plain', 'bash'),
      call('plain/1', 'read', 'plain'),
    ];
    expect(groupCodemodeCalls(items)).toEqual(items);
  });

  it('renders descendants as peer rows with a visible and accessible codemode indicator', () => {
    const [root, child, unrelated] = groupCodemodeCalls([
      call('root', 'codemode', undefined, 'running'),
      call('root/1', 'read', 'root'),
      call('unrelated', 'marker'),
    ]);
    const markup = [root, child, unrelated]
      .map((item) =>
        item ? renderToStaticMarkup(<TranscriptEntry item={item} />) : '',
      )
      .join('');
    expect(markup.indexOf('Codemode')).toBeLessThan(
      markup.indexOf('via codemode'),
    );
    expect(markup.indexOf('marker')).toBeGreaterThan(
      markup.indexOf('via codemode'),
    );
    expect(markup).toContain('Child results go to the script');
    expect(markup).toContain('directly to the agent.');
    expect(markup).toContain('class="tool-step-dot"');
    expect(markup).toContain('step-pending');
    expect(markup).not.toContain('codemode-children');
  });

  it('restores metadata-only children while a caught child error leaves the parent successful', () => {
    const [root] = groupCodemodeCalls(
      toTranscriptEntries([
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'root',
                name: 'codemode',
                arguments: {
                  code: 'try { await tools.read({path:"missing"}); } catch {}',
                },
              },
            ],
          },
        },
        {
          type: 'message',
          message: {
            role: 'toolResult',
            toolCallId: 'root',
            toolName: 'codemode',
            isError: false,
            content: [{ type: 'text', text: 'Selected script output' }],
            nestedCalls: {
              complete: true,
              calls: [
                {
                  id: 'root/1',
                  name: 'read',
                  status: 'error',
                  error: 'File unavailable',
                },
              ],
            },
          },
        },
      ]),
    );
    expect(root?.tool?.status).toBe('success');
    expect(root?.codemodeDescendants?.[0]?.tool).toMatchObject({
      name: 'read',
      status: 'error',
      errorMessage: 'File unavailable',
    });
    expect(root?.codemodeDescendants?.[0]?.tool).not.toHaveProperty('result');
    if (!root) throw new Error('Missing codemode root');
    const markup = renderToStaticMarkup(<TranscriptEntry item={root} />);
    expect(markup).toContain('Codemode');
    expect(markup).not.toContain('Running codemode');
    expect(markup).toContain('1 call');
    expect(markup).toContain('Script output');
    expect(markup).not.toContain('via codemode');
  });

  it('escapes source, bounds previews, and leaves unavailable streaming source explicit', () => {
    const item = call('root', 'codemode');
    if (!item.tool) throw new Error('Missing tool');
    const markup = renderToStaticMarkup(
      <CodemodeScript
        tool={{
          ...item.tool,
          arguments: { code: 'text("<img src=x onerror=alert(1)>");' },
        }}
      />,
    );
    expect(markup).toContain('&lt;img');
    expect(markup).not.toContain('<img');
    expect(
      renderToStaticMarkup(
        <CodemodeScript
          tool={{ ...item.tool, arguments: { code: 'x'.repeat(12_001) } }}
        />,
      ),
    ).toContain('Code preview is truncated');
    expect(renderToStaticMarkup(<CodemodeScript tool={item.tool} />)).toContain(
      'Script source is unavailable',
    );
  });

  it('uses the canonical tool timestamp rather than a raw envelope or parent override', () => {
    const item = call('root/1', 'bash', 'root');
    if (!item.tool) throw new Error('Missing tool');
    expect(
      transcriptItemTimestamp({
        ...item,
        raw: { timestamp: 100 },
        tool: { ...item.tool, timestamp: 200 },
      }),
    ).toBe(200);
  });

  it('shows actual script output rather than nested-call metadata or invented child results', () => {
    const item = call('root', 'codemode');
    if (!item.tool) throw new Error('Missing tool');
    const markup = renderToStaticMarkup(
      <CodemodeOutput
        tool={{
          ...item.tool,
          result: {
            content: [{ type: 'text', text: 'Only the selected output' }],
            nestedCalls: {
              calls: [{ id: 'root/1', name: 'private-child-metadata' }],
            },
          },
        }}
      />,
    );
    expect(markup).toContain('Only the selected output');
    expect(markup).not.toContain('private-child-metadata');
    expect(renderToStaticMarkup(<CodemodeOutput tool={item.tool} />)).toBe('');
  });
});
