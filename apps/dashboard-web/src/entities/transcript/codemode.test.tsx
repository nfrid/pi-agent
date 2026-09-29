import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  groupCodemodeCalls,
  type TranscriptModelItem,
  toTranscriptEntries,
  transcriptToolItems,
} from '../../transcript';
import { CodemodeOutput, CodemodeScript } from './codemode';
import { TranscriptEntry } from './entries';
import { transcriptItemTimestamp } from './landmarks';

function call(
  id: string,
  name: string,
  parentToolCallId?: string,
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
      status: 'success',
      ...(parentToolCallId ? { parentToolCallId } : {}),
    },
  };
}

describe('codemode presentation', () => {
  it('groups each execution and deeper calls once without moving unrelated items or mutating inputs', () => {
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
      'direct',
      'second',
    ]);
    expect(grouped[0]?.toolChildren).toMatchObject([
      { key: 'root/1', toolChildren: [{ key: 'root/1/1' }] },
    ]);
    expect(grouped[2]?.toolChildren).toMatchObject([{ key: 'second/1' }]);
    expect(
      grouped.flatMap(transcriptToolItems).map((item) => item.key),
    ).toEqual(['root', 'root/1', 'root/1/1', 'direct', 'second', 'second/1']);
    expect(root).not.toHaveProperty('toolChildren');
    expect(child).not.toHaveProperty('toolChildren');
  });

  it('keeps orphan, cyclic, and non-codemode nested calls visible', () => {
    const items = [
      call('orphan', 'read', 'absent'),
      call('a', 'codemode', 'b'),
      call('b', 'codemode', 'a'),
      call('plain', 'bash'),
      call('plain/1', 'read', 'plain'),
    ];
    expect(groupCodemodeCalls(items)).toEqual(items);
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
    expect(root?.toolChildren?.[0]?.tool).toMatchObject({
      name: 'read',
      status: 'error',
      errorMessage: 'File unavailable',
    });
    expect(root?.toolChildren?.[0]?.tool).not.toHaveProperty('result');
    if (!root) throw new Error('Missing codemode root');
    const markup = renderToStaticMarkup(<TranscriptEntry item={root} />);
    expect(markup).toContain('Codemode execution');
    expect(markup).toContain('1 call');
    expect(markup).toContain('Script output');
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
