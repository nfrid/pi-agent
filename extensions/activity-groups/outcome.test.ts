import { describe, expect, it } from 'vitest';
import { endedWithToolFailure } from './outcome';
import type { SequenceItem } from './types';

let nextToolId = 0;

function tool(
  name: string,
  args: unknown,
  isError: boolean,
): Extract<SequenceItem, { type: 'tool' }> {
  nextToolId += 1;
  return {
    type: 'tool',
    id: `${name}-${nextToolId}`,
    name,
    args,
    status: 'complete',
    isError,
  };
}

describe('activity group outcomes', () => {
  it('does not warn when a failed command is followed by a successful retry', () => {
    expect(
      endedWithToolFailure([
        tool('bash', { command: './mg/mg ticket BTB-2178' }, true),
        tool('bash', { command: 'mg ticket BTB-2178' }, false),
      ]),
    ).toBe(false);
  });

  it('does not require tool-specific retry matching', () => {
    expect(
      endedWithToolFailure([
        tool('delegate', { task: 'review', run: 1 }, true),
        tool('delegate', { task: 'review', run: 2 }, false),
      ]),
    ).toBe(false);
  });

  it('warns when the final completed call failed', () => {
    expect(
      endedWithToolFailure([
        tool('read', { path: 'src/client.ts' }, false),
        tool('edit', { path: 'src/client.ts' }, true),
      ]),
    ).toBe(true);
  });
});
