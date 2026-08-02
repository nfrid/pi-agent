import { describe, expect, it } from 'vitest';
import { groupTranscript, headersOf } from './index.js';

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

  it('extracts model headers without rendering them', () => {
    const message = {
      content: [{ type: 'text', text: '**Inspecting files**' }],
    } as never;
    expect(headersOf(message)).toEqual(['Inspecting files']);
  });
});
