import { describe, expect, it } from 'vitest';
import { hasUnresolvedToolFailure } from './outcome';
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
  it('treats a corrected edit on the same file as a successful retry', () => {
    expect(
      hasUnresolvedToolFailure([
        tool(
          'edit',
          {
            path: 'src/client.ts',
            edits: [{ oldText: 'stale', newText: 'a' }],
          },
          true,
        ),
        tool('read', { path: 'src/client.ts' }, false),
        tool(
          'edit',
          {
            path: 'src/client.ts',
            edits: [{ oldText: 'actual', newText: 'a' }],
          },
          false,
        ),
      ]),
    ).toBe(false);
  });

  it('reopens an intent when a later corrected edit fails again', () => {
    expect(
      hasUnresolvedToolFailure([
        tool('edit', { path: 'src/client.ts', oldText: 'stale' }, true),
        tool('edit', { path: 'src/client.ts', oldText: 'actual' }, false),
        tool('edit', { path: 'src/client.ts', oldText: 'changed again' }, true),
      ]),
    ).toBe(true);
  });

  it('does not let an edit to another file hide a failure', () => {
    expect(
      hasUnresolvedToolFailure([
        tool('edit', { path: 'src/client.ts', oldText: 'a' }, true),
        tool('edit', { path: 'src/config.ts', oldText: 'a' }, false),
      ]),
    ).toBe(true);
  });

  it('treats a corrected Python run in the same working area as a retry', () => {
    expect(
      hasUnresolvedToolFailure([
        tool(
          'bash',
          { command: "python3 - <<'PY'\nraise TypeError()\nPY" },
          true,
        ),
        tool(
          'bash',
          { command: "python3 - <<'PY'\nprint('corrected request')\nPY" },
          false,
        ),
      ]),
    ).toBe(false);
  });

  it('matches corrected validation commands but not a different check', () => {
    expect(
      hasUnresolvedToolFailure([
        tool(
          'bash',
          { command: 'cd kibana-logs && bun run check', timeout: 120 },
          true,
        ),
        tool(
          'bash',
          {
            command:
              'cd kibana-logs && bunx biome check --write . && bun run check',
            timeout: 180,
          },
          false,
        ),
      ]),
    ).toBe(false);

    expect(
      hasUnresolvedToolFailure([
        tool('bash', { command: 'npm run lint' }, true),
        tool('bash', { command: 'npm test' }, false),
      ]),
    ).toBe(true);
  });

  it('recognizes an aggregate check retried as explicit validations', () => {
    expect(
      hasUnresolvedToolFailure([
        tool(
          'bash',
          {
            command:
              'cd kibana-logs && bun run check && cd ../mg && bun run check',
          },
          true,
        ),
        tool(
          'bash',
          {
            command:
              'cd mg && bun run typecheck && bunx biome check . && bun test',
          },
          false,
        ),
      ]),
    ).toBe(false);
  });

  it('recognizes the same command after its working-directory setup is fixed', () => {
    expect(
      hasUnresolvedToolFailure([
        tool(
          'bash',
          {
            command:
              'source ../scratch/.env; bun run src/index.ts logs doctor --agent',
          },
          true,
        ),
        tool(
          'bash',
          {
            command:
              'cd mg; source ../scratch/.env; bun run src/index.ts logs doctor --agent',
          },
          false,
        ),
      ]),
    ).toBe(false);
  });

  it('keeps identical package commands in different projects separate', () => {
    expect(
      hasUnresolvedToolFailure([
        tool('bash', { command: 'cd project-a && npm test' }, true),
        tool('bash', { command: 'cd project-b && npm test' }, false),
      ]),
    ).toBe(true);
  });

  it('does not treat validation words inside a heredoc as commands', () => {
    expect(
      hasUnresolvedToolFailure([
        tool(
          'bash',
          {
            command:
              "python3 - <<'PY'\nprint('npm test')\nraise Exception()\nPY",
          },
          true,
        ),
        tool('bash', { command: 'npm test' }, false),
      ]),
    ).toBe(true);
  });

  it('does not resolve retries that are still running', () => {
    const retry = tool('edit', { path: 'src/client.ts' }, false);
    retry.status = 'running';
    expect(
      hasUnresolvedToolFailure([
        tool('edit', { path: 'src/client.ts', oldText: 'stale' }, true),
        retry,
      ]),
    ).toBe(true);
  });
});
