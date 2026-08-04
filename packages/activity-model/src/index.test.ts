import { describe, expect, it } from 'vitest';
import { groupTranscript, headersOf, projectActivityGroups } from './index.js';

describe('shared activity model', () => {
  it('groups the same pure transcript deterministically', () => {
    const entries = [
      { kind: 'assistant' as const, speaks: false },
      { kind: 'tool' as const, name: 'read', args: { path: 'a.ts' } },
      { kind: 'tool' as const, name: 'grep', args: { pattern: 'x' } },
    ];
    expect(groupTranscript(entries)).toEqual([{ start: 0, end: 2 }]);
    expect(groupTranscript(entries)).toEqual(groupTranscript(entries));
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

  it('projects failed and streaming groups distinctly for every renderer', () => {
    const failed = projectActivityGroups([
      { kind: 'assistant' as const, speaks: false },
      {
        kind: 'tool' as const,
        name: 'bash',
        args: { command: 'false' },
        isError: true,
      },
    ]);
    const streaming = projectActivityGroups([
      { kind: 'assistant' as const, speaks: false, streaming: true },
      { kind: 'tool' as const, name: 'bash', args: {} },
    ]);
    expect(failed[0]).toMatchObject({ status: 'failed', failureCount: 1 });
    expect(streaming[0]?.status).toBe('preparing');
    expect(failed[0]?.status).not.toBe(streaming[0]?.status);
  });

  it('extracts model headers without rendering them', () => {
    const message = {
      content: [{ type: 'text', text: '**Inspecting files**' }],
    } as never;
    expect(headersOf(message)).toEqual(['Inspecting files']);
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
      { kind: 'assistant', speaks: false },
      { kind: 'tool', name: 'read', args: {}, status: 'success' },
      { kind: 'assistant', speaks: false },
      { kind: 'tool', name: 'edit', args: {}, status: 'running' },
    ]);
    expect(groups.map(({ status }) => status)).toEqual(['complete', 'live']);
  });
});
