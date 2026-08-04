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
    const historical = projectActivityGroups(entries, { completed: true });
    const live = projectActivityGroups(entries, { completed: false });
    expect(live[0]).toMatchObject({
      start: historical[0]?.start,
      end: historical[0]?.end,
      title: 'Checking the workspace',
    });
    expect(historical[0]?.status).toBe('complete');
    expect(live[0]?.status).toBe('live');
  });

  it('extracts model headers without rendering them', () => {
    const message = {
      content: [{ type: 'text', text: '**Inspecting files**' }],
    } as never;
    expect(headersOf(message)).toEqual(['Inspecting files']);
  });
});
