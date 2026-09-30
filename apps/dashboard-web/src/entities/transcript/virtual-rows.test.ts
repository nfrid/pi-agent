import { describe, expect, it } from 'vitest';
import type { TranscriptModelItem } from '../../transcript';
import {
  buildVirtualTranscriptRows,
  shouldPreserveWorkLogOnAppend,
} from './virtual-rows';

function item(
  key: string,
  role?: 'user' | 'assistant',
  extra: Partial<TranscriptModelItem> = {},
): TranscriptModelItem {
  return {
    key,
    entry: { kind: 'other' },
    raw: { type: 'message', message: { id: key } },
    ...(role ? { role } : {}),
    ...extra,
  };
}

const items = [
  item('request', 'user'),
  item('thinking', 'assistant'),
  item('answer', 'assistant', {
    workLogClosure: {
      requestMessageId: 'request',
      finalMessageId: 'answer',
      startedAt: 1_000,
      endedAt: 91_000,
    },
  }),
];

describe('transcript work-log row plan', () => {
  it('preserves a newly closed work log when reading or when inner details are open', () => {
    const closure = items[2]?.workLogClosure;
    if (!closure) throw new Error('Missing test closure');
    expect(
      shouldPreserveWorkLogOnAppend(
        closure,
        items,
        [],
        new Set(),
        new Set(),
        'following',
      ),
    ).toBe(false);
    expect(
      shouldPreserveWorkLogOnAppend(
        closure,
        items,
        [],
        new Set(),
        new Set(),
        'reading',
      ),
    ).toBe(true);
    const request = items[0];
    const answer = items[2];
    if (!request || !answer) throw new Error('Missing test boundaries');
    const withAction = [request, item('tool-action'), answer];
    expect(
      shouldPreserveWorkLogOnAppend(
        closure,
        withAction,
        [],
        new Set(),
        new Set(['tool-action']),
        'following',
      ),
    ).toBe(true);
    expect(
      shouldPreserveWorkLogOnAppend(
        closure,
        items,
        [{ key: 'tool-stream-thinking', start: 1, end: 1 }],
        new Set(['tool-stream-thinking']),
        new Set(),
        'following',
      ),
    ).toBe(true);
  });

  it('replaces only closure interior and preserves request and final rows', () => {
    const rows = buildVirtualTranscriptRows(items);
    expect(
      rows.map((row) => (row.kind === 'entry' ? row.key : row.kind)),
    ).toEqual(['request', 'work-log', 'answer']);
    expect(rows[1]).toMatchObject({
      kind: 'work-log',
      durationMs: 90_000,
      actionCount: 0,
      expanded: false,
    });
  });

  it('restores the interior rows when the stable disclosure key is open', () => {
    const rows = buildVirtualTranscriptRows(
      items,
      new Set(['work-log-answer']),
    );
    expect(
      rows.map((row) => (row.kind === 'entry' ? row.key : row.kind)),
    ).toEqual(['request', 'work-log', 'thinking', 'answer']);
    expect(rows[1]).toMatchObject({ kind: 'work-log', expanded: true });
  });

  it('counts multi-child codemode actions without counting their wrapper', () => {
    const firstChild = item('child-1', undefined, {
      tool: { toolCallId: 'child-1', name: 'read' } as never,
      codemodeRootKey: 'root',
    });
    const secondChild = item('child-2', undefined, {
      tool: { toolCallId: 'child-2', name: 'bash' } as never,
      codemodeRootKey: 'root',
    });
    const rows = buildVirtualTranscriptRows([
      item('request', 'user'),
      item('root', undefined, {
        tool: { toolCallId: 'root', name: 'codemode' } as never,
        codemodeDescendants: [firstChild, secondChild],
      }),
      firstChild,
      secondChild,
      item('answer', 'assistant', {
        workLogClosure: {
          requestMessageId: 'request',
          finalMessageId: 'answer',
          startedAt: 1,
          endedAt: 2,
        },
      }),
    ]);
    expect(rows.find((row) => row.kind === 'work-log')).toMatchObject({
      actionCount: 2,
    });
  });

  it('fails open on invalid time, steering boundary, and extra ordinary user', () => {
    const marker = {
      requestMessageId: 'request',
      finalMessageId: 'answer',
      startedAt: 10,
      endedAt: 5,
    };
    expect(
      buildVirtualTranscriptRows([
        item('request', 'user'),
        item('work', 'assistant'),
        item('answer', 'assistant', { workLogClosure: marker }),
      ]).some((row) => row.kind === 'work-log'),
    ).toBe(false);
    expect(
      buildVirtualTranscriptRows([
        item('steer', 'user', { deliveryMode: 'steer' }),
        item('work', 'assistant'),
        item('answer', 'assistant', {
          workLogClosure: { ...marker, requestMessageId: 'steer', endedAt: 15 },
        }),
      ]).some((row) => row.kind === 'work-log'),
    ).toBe(false);
    expect(
      buildVirtualTranscriptRows([
        item('request', 'user'),
        item('follow-up', 'user'),
        item('work', 'assistant'),
        item('answer', 'assistant', {
          workLogClosure: { ...marker, endedAt: 15 },
        }),
      ]).some((row) => row.kind === 'work-log'),
    ).toBe(false);
  });

  it('keeps a final answer out of a later tool stream', () => {
    const rows = buildVirtualTranscriptRows([
      item('request', 'user'),
      item('tool-before', undefined, {
        tool: { toolCallId: 'before', name: 'read' } as never,
      }),
      item('answer', 'assistant', {
        thinking: ['Final answer preamble'],
        workLogClosure: {
          requestMessageId: 'request',
          finalMessageId: 'answer',
          startedAt: 1,
          endedAt: 2,
        },
      }),
      item('background', undefined, {
        tool: { toolCallId: 'background', name: 'background' } as never,
      }),
    ]);
    expect(
      rows.find((row) => row.kind === 'entry' && row.key === 'answer'),
    ).toBeDefined();
    expect(
      rows
        .filter((row) => row.kind === 'tool-stream')
        .every(
          (row) =>
            row.kind === 'tool-stream' && row.start !== 2 && row.end !== 2,
        ),
    ).toBe(true);
  });

  it('fails open when either exact boundary is absent', () => {
    const partial = [
      item('orphan', 'assistant', {
        workLogClosure: {
          requestMessageId: 'missing',
          finalMessageId: 'orphan',
          startedAt: 1,
          endedAt: 2,
        },
      }),
    ];
    expect(buildVirtualTranscriptRows(partial)).toEqual([
      { kind: 'entry', key: 'orphan', index: 0 },
    ]);
  });
});
