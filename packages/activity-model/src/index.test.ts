import { describe, expect, it } from 'vitest';
import {
  groupTranscript,
  headersOf,
  projectActivityGroups,
  toolActionSummary,
} from './index.js';

describe('tool action summaries', () => {
  it('keeps high-signal arguments in bounded labels', () => {
    expect(
      toolActionSummary({ name: 'bash', args: { command: 'pnpm test' } }),
    ).toBe('bash pnpm test');
    expect(
      toolActionSummary({ name: 'read', args: { path: 'src/App.tsx' } }),
    ).toBe('read src/App.tsx');
    expect(
      toolActionSummary({
        name: 'delegate',
        args: { action: 'start', name: 'Fix queue handling' },
      }),
    ).toBe('delegate start: Fix queue handling');
    expect(
      toolActionSummary({ name: 'todo', args: { action: 'done', id: 'T2' } }),
    ).toBe('todo done T2');
    expect(
      toolActionSummary({ name: 'web_search', args: { query: 'React Aria' } }),
    ).toBe('web_search: React Aria');
  });

  it('does not emit an unbounded command or argument value', () => {
    const summary = toolActionSummary({
      name: 'bash',
      args: { command: 'x'.repeat(500) },
    });
    expect(summary.length).toBeLessThanOrEqual(140);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('shared activity model', () => {
  it('groups the same pure transcript deterministically', () => {
    const entries = [
      {
        kind: 'assistant' as const,
        speaks: false,
        title: 'Inspect the project',
        titleKind: 'preamble' as const,
      },
      { kind: 'tool' as const, name: 'read', args: { path: 'a.ts' } },
      { kind: 'tool' as const, name: 'grep', args: { pattern: 'x' } },
    ];
    expect(groupTranscript(entries)).toEqual([{ start: 0, end: 2 }]);
    expect(groupTranscript(entries)).toEqual(groupTranscript(entries));
  });

  it('keeps opted-in semantic events inside an active group', () => {
    const entries = [
      {
        kind: 'assistant' as const,
        speaks: true,
        title: 'Track the work',
        titleKind: 'preamble' as const,
      },
      { kind: 'other' as const, continuesGroup: true },
      { kind: 'tool' as const, name: 'read', args: {} },
      { kind: 'other' as const, continuesGroup: true },
      { kind: 'tool' as const, name: 'edit', args: {} },
      { kind: 'other' as const, continuesGroup: true },
    ];
    expect(groupTranscript(entries)).toEqual([{ start: 0, end: 5 }]);
    expect(
      groupTranscript([
        { kind: 'other', continuesGroup: true },
        { kind: 'tool', name: 'read', args: {} },
      ]),
    ).toEqual([]);
    expect(
      groupTranscript([entries[0], entries[2], { kind: 'other' }, entries[4]]),
    ).toEqual([{ start: 0, end: 1 }]);
  });

  it('keeps historical and live projections on the same boundaries and title', () => {
    const entries = [
      {
        kind: 'assistant' as const,
        speaks: true,
        title: 'Checking the workspace',
        titleKind: 'preamble' as const,
      },
      { kind: 'tool' as const, name: 'bash', args: { command: 'npm test' } },
    ];
    const historical = projectActivityGroups(entries);
    const live = projectActivityGroups(entries, { liveTail: true });
    expect(live[0]).toMatchObject({
      start: historical[0]?.start,
      end: historical[0]?.end,
      title: 'Checking the workspace',
    });
    expect(historical[0]?.status).toBe('complete');
    expect(live[0]?.status).toBe('live');
  });

  it('finishes the prior group when a later assistant message closes the work', () => {
    const entries = [
      {
        kind: 'assistant' as const,
        speaks: false,
        title: 'Read the project',
        titleKind: 'preamble' as const,
      },
      {
        kind: 'tool' as const,
        name: 'read',
        args: {},
        status: 'success' as const,
      },
      { kind: 'assistant' as const, speaks: true },
    ];

    expect(projectActivityGroups(entries, { liveTail: true })[0]?.status).toBe(
      'complete',
    );
  });

  it('does not emit a settled preamble without a tool', () => {
    expect(
      groupTranscript([
        {
          kind: 'assistant',
          speaks: false,
          title: 'Preparing the response',
          titleKind: 'preamble',
        },
      ]),
    ).toEqual([]);
  });

  it('emits a streaming preamble before its first tool arrives', () => {
    expect(
      groupTranscript([
        {
          kind: 'assistant',
          speaks: false,
          streaming: true,
          title: 'Preparing the response',
          titleKind: 'preamble',
        },
      ]),
    ).toEqual([{ start: 0, end: 0 }]);
  });

  it('keeps unresolved failures live until the active group finishes', () => {
    const failed = {
      kind: 'tool' as const,
      name: 'bash',
      args: { command: 'false' },
      status: 'error' as const,
      isError: true,
    };
    const terminalEntries = [
      {
        kind: 'assistant' as const,
        speaks: false,
        title: 'Run the command',
        titleKind: 'preamble' as const,
      },
      failed,
    ];
    const mixedEntries = [
      ...terminalEntries,
      {
        kind: 'tool' as const,
        name: 'read',
        args: {},
        status: 'running' as const,
      },
    ];

    expect(
      projectActivityGroups(terminalEntries, { liveTail: true })[0]?.status,
    ).toBe('live');
    expect(projectActivityGroups(mixedEntries)[0]?.status).toBe('live');
    expect(projectActivityGroups(terminalEntries)[0]?.status).toBe('failed');
  });

  it('uses retry-aware outcomes for shared dashboard projections', () => {
    const corrected = projectActivityGroups([
      {
        kind: 'assistant' as const,
        speaks: false,
        title: 'Correct the check',
        titleKind: 'preamble' as const,
      },
      {
        kind: 'tool' as const,
        name: 'bash',
        args: { command: 'npm run lint' },
        status: 'error' as const,
        isError: true,
      },
      {
        kind: 'tool' as const,
        name: 'bash',
        args: { command: 'npm run lint -- --fix' },
        status: 'success' as const,
      },
    ]);
    const unresolved = projectActivityGroups([
      {
        kind: 'assistant' as const,
        speaks: false,
        title: 'Investigate the failure',
        titleKind: 'preamble' as const,
      },
      {
        kind: 'tool' as const,
        name: 'bash',
        args: { command: 'npm run lint' },
        status: 'error' as const,
        isError: true,
      },
      {
        kind: 'tool' as const,
        name: 'bash',
        args: { command: 'npm test' },
        status: 'success' as const,
      },
    ]);
    expect(corrected[0]?.status).toBe('complete');
    expect(unresolved[0]?.status).toBe('failed');
  });

  it('projects failed and streaming groups distinctly for every renderer', () => {
    const failed = projectActivityGroups([
      {
        kind: 'assistant' as const,
        speaks: false,
        title: 'Run the failing command',
        titleKind: 'preamble' as const,
      },
      {
        kind: 'tool' as const,
        name: 'bash',
        args: { command: 'false' },
        isError: true,
      },
    ]);
    const streaming = projectActivityGroups([
      {
        kind: 'assistant' as const,
        speaks: false,
        streaming: true,
        title: 'Prepare the command',
        titleKind: 'preamble' as const,
      },
      { kind: 'tool' as const, name: 'bash', args: {} },
    ]);
    expect(failed[0]?.status).toBe('failed');
    expect(streaming[0]?.status).toBe('preparing');
    expect(failed[0]?.status).not.toBe(streaming[0]?.status);
  });

  it('titles a group from its preamble, never from thinking narration', () => {
    const groups = projectActivityGroups([
      {
        kind: 'assistant',
        speaks: false,
        title: 'The announced task',
        titleKind: 'preamble',
      },
      { kind: 'tool', name: 'read', args: {} },
      {
        kind: 'assistant',
        speaks: false,
        title: 'A private thought',
        titleKind: 'narration',
      },
      { kind: 'tool', name: 'edit', args: {} },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe('The announced task');
  });

  it('extracts model headers without rendering them', () => {
    const message = {
      content: [{ type: 'text', text: '**Inspecting files**' }],
    } as never;
    expect(headersOf(message)).toEqual(['Inspecting files']);
  });

  it('ignores nullable provider placeholders while a message streams', () => {
    const message = {
      content: [
        null,
        { type: 'thinking', thinking: '**Planning the response**' },
      ],
    } as never;
    expect(headersOf(message)).toEqual(['Planning the response']);
  });

  it('keeps boundaries, titles, status, and expansion semantic across surfaces', () => {
    const entries = [
      {
        kind: 'assistant' as const,
        speaks: true,
        title: 'Inspecting the workspace',
        titleKind: 'preamble' as const,
      },
      { kind: 'tool' as const, name: 'read', args: { path: 'src/App.tsx' } },
      { kind: 'tool' as const, name: 'grep', args: { pattern: 'palette' } },
      {
        kind: 'assistant' as const,
        speaks: true,
        title: 'Editing the control surface',
        titleKind: 'preamble' as const,
      },
      { kind: 'tool' as const, name: 'edit', args: { path: 'src/App.tsx' } },
    ];
    const historical = projectActivityGroups(entries, {
      expandedIds: new Set(['activity-group-0']),
    });
    const live = projectActivityGroups(entries, {
      liveTail: true,
      expandedIds: new Set(['activity-group-0']),
    });
    expect(
      historical.map(({ start, end, title }) => ({ start, end, title })),
    ).toEqual(live.map(({ start, end, title }) => ({ start, end, title })));
    expect(
      historical.map(({ status, expanded, kind, toolCount }) => ({
        status,
        expanded,
        kind,
        toolCount,
      })),
    ).toEqual([
      { status: 'complete', expanded: true, kind: 'inspect', toolCount: 2 },
      { status: 'complete', expanded: false, kind: 'mutate', toolCount: 1 },
    ]);
    expect(
      live.map(({ status, expanded, kind, toolCount }) => ({
        status,
        expanded,
        kind,
        toolCount,
      })),
    ).toEqual([
      { status: 'complete', expanded: true, kind: 'inspect', toolCount: 2 },
      { status: 'live', expanded: false, kind: 'mutate', toolCount: 1 },
    ]);
  });

  it('marks an explicitly pending tail live without reopening completed groups', () => {
    const groups = projectActivityGroups([
      {
        kind: 'assistant',
        speaks: false,
        title: 'Read the file',
        titleKind: 'preamble',
      },
      { kind: 'tool', name: 'read', args: {}, status: 'success' },
      {
        kind: 'assistant',
        speaks: false,
        title: 'Edit the file',
        titleKind: 'preamble',
      },
      { kind: 'tool', name: 'edit', args: {}, status: 'running' },
    ]);
    expect(groups.map(({ status }) => status)).toEqual(['complete', 'live']);
  });
});
