import { describe, expect, it } from 'vitest';
import { hasUnresolvedToolFailure, validationKindsOf } from './outcome.mjs';

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
  it('resolves a failed validation with a semantically equivalent retry', () => {
    expect(
      hasUnresolvedToolFailure([
        tool('bash', { command: 'cd app && npm run lint' }, 'error'),
        tool('bash', { command: 'cd app && npm run lint -- --fix' }),
      ]),
    ).toBe(false);
  });

  it('keeps an unrelated successful validation from resolving a failure', () => {
    expect(
      hasUnresolvedToolFailure([
        tool('bash', { command: 'npm run lint' }, 'error'),
        tool('bash', { command: 'npm test' }),
      ]),
    ).toBe(true);
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
