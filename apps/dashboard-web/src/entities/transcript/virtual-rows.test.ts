import { describe, expect, it } from 'vitest';
import type { TranscriptModelItem } from '../../transcript';
import {
  buildVirtualTranscriptRows,
  isNewWorkLogClosureAppend,
  shouldPreserveWorkLogOnAppend,
  workLogTranscriptScopeKey,
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

  it('keeps a transcript scope stable on leaf appends and changes it on branch selection', () => {
    const topology = {
      activeLeafId: 'leaf-one',
      points: [
        {
          id: 'fork',
          paths: [
            {
              id: 'path-one',
              messageId: 'path-one',
              label: 'One',
              current: true,
            },
            {
              id: 'path-two',
              messageId: 'path-two',
              label: 'Two',
              current: false,
            },
          ],
        },
      ],
    };
    const first = workLogTranscriptScopeKey('session', topology);
    const fork = topology.points[0];
    if (!fork) throw new Error('Missing test fork');
    expect(
      workLogTranscriptScopeKey('session', {
        ...topology,
        activeLeafId: 'new-leaf-on-same-path',
      }),
    ).toBe(first);
    expect(
      workLogTranscriptScopeKey('session', {
        ...topology,
        activeLeafId: 'alternate-leaf',
        points: [
          {
            ...fork,
            paths: fork.paths.map((path) => ({
              ...path,
              current: path.id === 'path-two',
            })),
          },
        ],
      }),
    ).not.toBe(first);
  });

  it('recognizes appended closures but not closures discovered in a page prepend', () => {
    const closure = items[2]?.workLogClosure;
    if (!closure) throw new Error('Missing test closure');
    const withoutClosure = items.map((entry) => {
      const { workLogClosure: _workLogClosure, ...rest } = entry;
      return rest;
    });
    expect(isNewWorkLogClosureAppend(closure, items, withoutClosure)).toBe(
      true,
    );
    expect(
      isNewWorkLogClosureAppend(
        closure,
        [item('older-entry'), ...items],
        items,
      ),
    ).toBe(false);
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

  it('keeps a trusted closure collapsed when its exact request is on an older page', () => {
    const partial = [
      item('work-on-latest-page', 'assistant'),
      item('answer', 'assistant', {
        workLogClosure: {
          requestMessageId: 'older-request',
          finalMessageId: 'answer',
          startedAt: 1,
          endedAt: 2,
        },
      }),
    ];
    const rows = buildVirtualTranscriptRows(partial, new Set(), {
      historyStart: 8,
      outline: [
        { id: 'older-request', ordinal: 1, kind: 'user', label: 'Request' },
      ],
    });
    expect(rows.map((row) => row.kind)).toEqual(['work-log', 'entry']);
    expect(rows[0]).toMatchObject({
      kind: 'work-log',
      expanded: false,
      requestOrdinal: 1,
    });
    expect(rows[0]?.kind === 'work-log' && rows[0].actionCount).toBeUndefined();
  });

  it('shows a lazy placeholder when only the final answer is loaded', () => {
    const finalOnly = [
      item('answer', 'assistant', {
        workLogClosure: {
          requestMessageId: 'older-request',
          finalMessageId: 'answer',
          startedAt: 1,
          endedAt: 2,
        },
      }),
    ];
    const options = {
      historyStart: 8,
      outline: [
        {
          id: 'older-request',
          ordinal: 1,
          kind: 'user' as const,
          label: 'Old',
        },
      ],
    };
    const finalRows = buildVirtualTranscriptRows(finalOnly, new Set(), options);
    expect(finalRows).toEqual([
      expect.objectContaining({
        kind: 'work-log',
        start: 0,
        end: -1,
        expanded: false,
        requestOrdinal: 1,
      }),
      { kind: 'entry', key: 'answer', index: 0 },
    ]);
    expect(finalRows[0]).not.toHaveProperty('actionCount');
    expect(
      buildVirtualTranscriptRows(
        finalOnly,
        new Set(['work-log-answer']),
        options,
      )[0],
    ).toMatchObject({ kind: 'work-log', expanded: true });
  });

  it('uses steering landmarks to validate gaps and keeps independent complete folds', () => {
    const partialClosure = {
      requestMessageId: 'older-request',
      finalMessageId: 'partial-answer',
      startedAt: 1,
      endedAt: 2,
    };
    const completeClosure = {
      requestMessageId: 'next-request',
      finalMessageId: 'complete-answer',
      startedAt: 3,
      endedAt: 4,
    };
    const partialAndComplete = [
      item('partial-work', 'assistant'),
      item('partial-answer', 'assistant', {
        workLogClosure: partialClosure,
      }),
      item('next-request', 'user'),
      item('complete-work', 'assistant'),
      item('complete-answer', 'assistant', {
        workLogClosure: completeClosure,
      }),
    ];
    const validGap = {
      historyStart: 8,
      outline: [
        {
          id: 'older-request',
          ordinal: 1,
          kind: 'user' as const,
          label: 'Old',
        },
        {
          id: 'steering-user',
          ordinal: 4,
          kind: 'user' as const,
          deliveryMode: 'steer' as const,
          label: 'Redirect',
        },
        {
          id: 'next-request',
          ordinal: 9,
          kind: 'user' as const,
          label: 'Next',
        },
      ],
    };
    const rows = buildVirtualTranscriptRows(
      partialAndComplete,
      new Set(),
      validGap,
    );
    expect(rows.filter((row) => row.kind === 'work-log')).toHaveLength(2);
    expect(
      rows.map((row) => (row.kind === 'entry' ? row.key : row.kind)),
    ).toEqual([
      'work-log',
      'partial-answer',
      'next-request',
      'work-log',
      'complete-answer',
    ]);
    const withFollowUp = buildVirtualTranscriptRows(
      partialAndComplete,
      new Set(),
      {
        ...validGap,
        outline: [
          ...validGap.outline,
          { id: 'ordinary-user', ordinal: 6, kind: 'user', label: 'Follow-up' },
        ],
      },
    );
    expect(withFollowUp.filter((row) => row.kind === 'work-log')).toHaveLength(
      1,
    );
    expect(withFollowUp.find((row) => row.kind === 'work-log')?.key).toBe(
      'work-log-complete-answer',
    );
  });

  it('rejects ambiguous, non-user, and not-yet-covered outline boundaries', () => {
    const partial = [
      item('work', 'assistant'),
      item('answer', 'assistant', {
        workLogClosure: {
          requestMessageId: 'request',
          finalMessageId: 'answer',
          startedAt: 1,
          endedAt: 2,
        },
      }),
    ];
    const options = {
      historyStart: 8,
      outline: [
        { id: 'request', ordinal: 1, kind: 'user' as const, label: 'Request' },
      ],
    };
    expect(
      buildVirtualTranscriptRows(partial, new Set(), options).some(
        (row) => row.kind === 'work-log',
      ),
    ).toBe(true);
    expect(
      buildVirtualTranscriptRows(partial, new Set(), {
        ...options,
        outline: [
          ...options.outline,
          { id: 'request', ordinal: 2, kind: 'user', label: 'Duplicate' },
        ],
      }).some((row) => row.kind === 'work-log'),
    ).toBe(false);
    expect(
      buildVirtualTranscriptRows(partial, new Set(), {
        ...options,
        outline: [
          { id: 'request', ordinal: 1, kind: 'assistant', label: 'Wrong role' },
        ],
      }).some((row) => row.kind === 'work-log'),
    ).toBe(false);
    expect(
      buildVirtualTranscriptRows(partial, new Set(), {
        ...options,
        historyStart: 0,
      }).some((row) => row.kind === 'work-log'),
    ).toBe(false);
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
