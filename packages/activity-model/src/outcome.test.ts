import { describe, expect, it } from 'vitest';
import { endedWithToolFailure, validationKindsOf } from './outcome.mjs';

function tool(
  name: string,
  args: unknown,
  status: 'error' | 'success' = 'success',
) {
  return {
    name,
    args,
    status,
    isError: status === 'error',
  } as const;
}

describe('shared activity outcomes', () => {
  it('warns only when the final completed tool call failed', () => {
    expect(
      endedWithToolFailure([
        tool('bash', { command: './mg/mg ticket BTB-2178' }, 'error'),
        tool('bash', { command: 'mg ticket BTB-2178' }),
      ]),
    ).toBe(false);
    expect(
      endedWithToolFailure([
        tool('bash', { command: 'npm test' }),
        tool('delegate', { task: 'review' }, 'error'),
      ]),
    ).toBe(true);
  });

  it('does not warn while a retry is still in flight', () => {
    expect(
      endedWithToolFailure([
        tool('bash', { command: 'false' }, 'error'),
        {
          name: 'read',
          args: {},
          status: 'running' as const,
          isError: false,
        },
      ]),
    ).toBe(false);
  });

  it('preserves validation command facets', () => {
    expect(validationKindsOf('bash', { command: 'pnpm run check' })).toEqual([
      'check',
    ]);
    expect(
      validationKindsOf('bash', {
        command: "python - <<'PY'\nprint('npm test')\nPY",
      }),
    ).toEqual([]);
  });
});
