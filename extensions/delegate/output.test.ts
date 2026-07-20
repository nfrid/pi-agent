import { describe, expect, test, vi } from 'vitest';
import { parseDelegateConfig, resolveDelegateRoute } from './config';
import {
  buildParentHandoff,
  PARENT_HANDOFF_CAPS,
  truncateBytes,
} from './output';
import { buildArtifactBackedHandoff } from './tool-result';
import { createRun, getFinalAssistantText } from './types';

const assistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
};

describe('output', () => {
  test('caps parent-visible output by UTF-8 bytes', () => {
    const output = truncateBytes('🙂'.repeat(100), 100);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(100);
    expect(output).toMatch(/Output truncated/);
  });

  test('artifacts only exact final assistant output omitted by handoff caps', async () => {
    const protectedValues = {
      task: 'PROTECTED_TASK',
      contextNote: 'PROTECTED_CONTEXT',
      user: 'PROTECTED_CHILD_INPUT',
      approval: 'PROTECTED_APPROVAL',
      decision: 'PROTECTED_DECISION',
      stderr: 'PROTECTED_STDERR',
    };
    const exact = `  exact child output\n${'x'.repeat(20_000)}\n`;
    const run = createRun(protectedValues.task, undefined, {
      contextNote: protectedValues.contextNote,
      continuation: 'continue-safe',
    });
    run.exitCode = 0;
    run.state = 'success';
    run.stderr = protectedValues.stderr;
    run.messages = [
      {
        role: 'user',
        content: `${protectedValues.user} ${protectedValues.approval} ${protectedValues.decision}`,
        timestamp: Date.now(),
      },
      {
        ...assistantMessage,
        content: [{ type: 'text', text: exact }],
      } as never,
    ] as never;
    const persisted: string[] = [];
    const put = async (
      _pi: unknown,
      _ctx: unknown,
      input: { bytes: string },
    ) => {
      persisted.push(input.bytes);
      return {
        handle: `art_${'d'.repeat(22)}`,
        sha256: 'a'.repeat(64),
        size: Buffer.byteLength(input.bytes),
        producer: 'delegate' as const,
        contentClass: 'delegate-output' as const,
        creationSource: 'delegate.result',
        encoding: 'utf-8' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    };
    const handoff = await buildArtifactBackedHandoff(
      {} as never,
      {} as never,
      [run],
      put as never,
    );
    expect(persisted).toEqual([exact]);
    for (const protectedValue of Object.values(protectedValues))
      expect(persisted[0]).not.toContain(protectedValue);
    expect(handoff).toContain(`Artifact: art_${'d'.repeat(22)}`);
    expect(handoff).toContain('Continuation: continue-safe');
    expect(run.messages).toHaveLength(2);
  });

  test('keeps successful handoff and metadata when artifact creation fails', async () => {
    const run = createRun('protected task', undefined, {
      continuation: 'continue-after-artifact-failure',
    });
    run.exitCode = 0;
    run.state = 'success';
    const exact = `Validation: passed\nChanged files: src/a.ts\n${'z'.repeat(20_000)}`;
    run.messages = [
      {
        ...assistantMessage,
        content: [{ type: 'text', text: exact }],
      } as never,
    ];
    const put = async () => {
      throw new Error('/secret/path or policy detail');
    };
    const handoff = await buildArtifactBackedHandoff(
      {} as never,
      {} as never,
      [run],
      put as never,
    );
    expect(handoff).toContain('Status: success');
    expect(handoff).toContain('Continuation: continue-after-artifact-failure');
    expect(handoff).toContain('Validation: passed');
    expect(handoff).toContain('Changed files: src/a.ts');
    expect(handoff).toContain('Exact output artifact unavailable');
    expect(handoff).not.toContain('/secret/path');
    expect(run.artifact).toBeUndefined();
  });

  test('does not artifact complete final output that fits the handoff', async () => {
    const run = createRun('protected task');
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [assistantMessage as never];
    const put = vi.fn();
    await buildArtifactBackedHandoff(
      {} as never,
      {} as never,
      [run],
      put as never,
    );
    expect(put).not.toHaveBeenCalled();
    expect(run.artifact).toBeUndefined();
  });

  test('uses fixed production parent handoff caps', () => {
    expect(PARENT_HANDOFF_CAPS).toEqual({
      singleMaxBytes: 12 * 1024,
      aggregateMaxBytes: 50 * 1024,
      perTaskMaxBytes: 8 * 1024,
    });
  });

  test('runtime configuration errors block route resolution', () => {
    const runtimeInvalid = parseDelegateConfig({
      timeoutMs: 1,
      provider: 'openai-codex',
      modelCatalog: {
        quick: {
          model: 'quick',
          thinking: 'high',
          relativeCost: 1,
          relativeIntelligence: 2,
        },
      },
    });
    expect(resolveDelegateRoute('quick', runtimeInvalid).error).toContain(
      'timeoutMs',
    );
  });

  test('reserves continuation and truncation metadata for all 20 tasks', () => {
    const runs = Array.from({ length: 20 }, (_, index) => {
      const run = createRun(`task ${index + 1}`, undefined, {
        continuation: `continuation-${index + 1}`,
      });
      run.exitCode = 0;
      run.state = 'success';
      run.messages = [
        {
          ...assistantMessage,
          content: [{ type: 'text', text: '🙂'.repeat(10_000) }],
        } as never,
      ];
      return run;
    });
    const output = buildParentHandoff(runs);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(
      PARENT_HANDOFF_CAPS.aggregateMaxBytes,
    );
    for (let index = 1; index <= 20; index++) {
      expect(output).toContain(`## Task ${index}\n`);
      expect(output).toContain(`Continuation: continuation-${index}`);
    }
    expect(output.match(/Truncation:/g)).toHaveLength(20);
  });

  test('preserves 20 maximum-length opaque continuations within handoff caps', () => {
    const continuations = Array.from(
      { length: 20 },
      (_, index) => `${index.toString().padStart(2, '0')}:${'界'.repeat(509)}`,
    );
    const runs = continuations.map((continuation, index) => {
      const run = createRun(`task ${index + 1}`, undefined, {
        continuation,
        warnings: ['w'.repeat(500)],
      });
      run.exitCode = 1;
      run.state = 'error';
      run.errorMessage = 'failure '.repeat(100);
      run.messages = [
        {
          ...assistantMessage,
          content: [
            {
              type: 'text',
              text: `Changed files:\n- ${'path/'.repeat(100)}\n\nValidation:\n- ${'check '.repeat(100)}`,
            },
          ],
        } as never,
      ];
      return run;
    });
    const output = buildParentHandoff(runs);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(
      PARENT_HANDOFF_CAPS.aggregateMaxBytes,
    );
    for (const continuation of continuations)
      expect(output).toContain(`Continuation: ${continuation}`);

    const impossible = buildParentHandoff(runs, {
      ...PARENT_HANDOFF_CAPS,
      aggregateMaxBytes: 4096,
    });
    expect(Buffer.byteLength(impossible, 'utf8')).toBeGreaterThan(4096);
    expect(impossible).toContain('Mandatory metadata exceeds');
    for (const continuation of continuations)
      expect(impossible).toContain(`Continuation: ${continuation}`);
  });

  test('keeps failure, validation, and changed-file evidence in the envelope', () => {
    const run = createRun('implement', undefined, {
      continuation: 'retry-token',
      warnings: ['scope overlap'],
    });
    run.exitCode = 1;
    run.state = 'error';
    run.errorMessage = 'Tests failed';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: `Changed files:\n- src/delegate.ts\n\nValidation:\n- npm test failed\n\n${'details '.repeat(4000)}`,
          },
        ],
      } as never,
    ];
    const output = buildParentHandoff([run], {
      ...PARENT_HANDOFF_CAPS,
      singleMaxBytes: 2048,
    });
    expect(output).toContain('Status: error');
    expect(output).toContain('Continuation: retry-token');
    expect(output).toContain('Failure: Tests failed');
    expect(output).toContain('Warnings: scope overlap');
    expect(output).toContain('Changed files: src/delegate.ts');
    expect(output).toContain('Validation: npm test failed');
    expect(output).toContain('Truncation: body truncated');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(2048);
  });

  test('bounded handoffs do not mutate full run details or transcripts', () => {
    const run = createRun('inspect', undefined, { continuation: 'full-token' });
    run.exitCode = 0;
    run.messages = [
      {
        ...assistantMessage,
        content: [{ type: 'text', text: 'exact transcript '.repeat(2000) }],
      } as never,
    ];
    const before = structuredClone(run);
    buildParentHandoff([run]);
    expect(run).toEqual(before);
    expect(getFinalAssistantText(run.messages)).toContain(
      'exact transcript exact transcript',
    );
  });
});
