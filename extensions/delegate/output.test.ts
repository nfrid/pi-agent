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

  test("carries a child's question and its answer route past body truncation", () => {
    const run = createRun('audit the retry path', undefined, {
      continuation: 'continue-blocked-child',
    });
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: `Read the retry path.\n\nBlocked: should a 429 retry, given the task says never retry?\n${'z'.repeat(20_000)}`,
          },
        ],
      } as never,
    ];

    const handoff = buildParentHandoff([run]);
    expect(handoff).toContain(
      'Blocked: should a 429 retry, given the task says never retry?',
    );
    expect(handoff).toContain('continue this subagent');
    // The token that answers the question has to survive with it.
    expect(handoff).toContain('Continuation: continue-blocked-child');
    expect(handoff).toContain('Output truncated');
  });

  test('leaves an ordinary report unblocked', () => {
    const run = createRun('audit the retry path', undefined, {});
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [assistantMessage as never];
    expect(buildParentHandoff([run])).not.toContain('Blocked:');
  });

  test('lifts the contract sections the parent decides on into the envelope', () => {
    const run = createRun('audit the cache', undefined, {
      continuation: 'contract-token',
    });
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: [
              'Outcome: partial',
              'Conclusion: the eviction path is wrong under concurrent reads',
              'Evidence:',
              '- src/cache.ts:212 drops the lock before the write',
              '- src/cache.ts:240 assumes the entry is still present',
              'Validation: npm test — 4 failed',
              'Risks: the fix may change eviction order for existing callers',
              `${'narration '.repeat(3000)}`,
            ].join('\n\n'),
          },
        ],
      } as never,
    ];

    const output = buildParentHandoff([run], {
      ...PARENT_HANDOFF_CAPS,
      singleMaxBytes: 2048,
    });
    expect(output).toContain('Outcome: partial');
    expect(output).toContain('Evidence: src/cache.ts:212 drops the lock');
    expect(output).toContain('src/cache.ts:240');
    expect(output).toContain('Validation: npm test — 4 failed');
    expect(output).toContain('Risks: the fix may change eviction order');
    expect(output).toContain('Truncation: body truncated');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(2048);
  });

  test('lifts evidence past Markdown blank lines even when no body fits', () => {
    const run = createRun('audit the evidence', undefined, {});
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: [
              'Outcome: partial',
              'Evidence:',
              '- src/first.ts:10 establishes the first condition',
              '',
              '- src/later.ts:42 preserves the later citation',
              '',
              'Conclusion: the body must not be needed for either citation',
            ].join('\n'),
          },
        ],
      } as never,
    ];

    // The envelope alone exceeds this deliberately tiny cap, so allocation
    // omits the body while mandatory evidence remains parent-visible.
    const output = buildParentHandoff([run], {
      ...PARENT_HANDOFF_CAPS,
      singleMaxBytes: 1,
    });
    expect(output).toContain('Evidence: src/first.ts:10');
    expect(output).toContain('src/later.ts:42 preserves the later citation');
    expect(output).not.toContain('Output\nConclusion:');
  });

  test('sends a lifted section once, not in the envelope and again in the body', () => {
    const run = createRun('audit the download path', undefined, {});
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: [
              '## Outcome',
              'done',
              '## Conclusion',
              'filenames collide on case-insensitive filesystems',
              '## Evidence',
              '- src/download.ts:46 writes without an existence check',
              '## Risks',
              'no runtime behaviour was exercised',
            ].join('\n\n'),
          },
        ],
      } as never,
    ];
    const output = buildParentHandoff([run]);

    expect(output).toContain('Evidence: src/download.ts:46 writes');
    expect(output).toContain('Risks: no runtime behaviour was exercised');
    // The conclusion is the body's job, and is never lifted away from it.
    expect(output).toContain(
      'filenames collide on case-insensitive filesystems',
    );
    for (const lifted of ['## Evidence', '## Risks', '## Outcome'])
      expect(output).not.toContain(lifted);
    expect(
      output.match(/no runtime behaviour was exercised/g) ?? [],
    ).toHaveLength(1);
  });

  test('keeps a section the envelope could only carry part of', () => {
    const run = createRun('audit every caller', undefined, {});
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: [
              'Conclusion: eight callers skip the guard',
              'Risks:',
              ...Array.from(
                { length: 8 },
                (_, index) =>
                  `- caller ${index} was not re-checked after the fix`,
              ),
            ].join('\n'),
          },
        ],
      } as never,
    ];
    const output = buildParentHandoff([run]);

    expect(output).toContain('Risks: caller 0 was not re-checked');
    // Eight lines outrun the field, so the body still owes the parent the rest.
    expect(output).toContain('caller 7 was not re-checked');
  });

  test('routes an exceeded task back to its own continuation', () => {
    const run = createRun('trace the cancellation path', undefined, {
      continuation: 'exceeded-token',
    });
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: '**Outcome:** partial\n\n**Exceeded:** this needs cancellation reasoning across the runner, the worktree lifecycle, and the job manager at once\n',
          },
        ],
      } as never,
    ];
    const output = buildParentHandoff([run]);
    expect(output).toContain('Outcome: partial');
    expect(output).toContain('Exceeded: this needs cancellation reasoning');
    expect(output).toContain(
      'continue this subagent on a route that covers it',
    );
    expect(output).toContain('Continuation: exceeded-token');
  });

  test('keeps the conclusion when the child narrates before answering', () => {
    const run = createRun('review the diff', undefined, {});
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: `${'I started by reading every caller. '.repeat(2000)}\n\nConclusion: the retry wrapper swallows AbortError, so cancellation never propagates.`,
          },
        ],
      } as never,
    ];
    const output = buildParentHandoff([run], {
      ...PARENT_HANDOFF_CAPS,
      singleMaxBytes: 1024,
    });
    expect(output).toContain(
      'Conclusion: the retry wrapper swallows AbortError',
    );
    expect(output).toContain('Truncation: body truncated');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(1024);
  });

  test('leaves a body that already carries its conclusion alone', () => {
    const run = createRun('review the diff', undefined, {});
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: `Conclusion: the guard is correct.\n\n${'supporting detail '.repeat(2000)}`,
          },
        ],
      } as never,
    ];
    const output = buildParentHandoff([run], {
      ...PARENT_HANDOFF_CAPS,
      singleMaxBytes: 1024,
    });
    expect(output).toContain('Conclusion: the guard is correct.');
    expect(output).toContain('supporting detail');
  });

  test('does not read prose opening with a section word as a section', () => {
    const run = createRun('summarise', undefined, {});
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        ...assistantMessage,
        content: [
          {
            type: 'text',
            text: 'Outcomes improved after the change, and risks were reviewed throughout.',
          },
        ],
      } as never,
    ];
    const output = buildParentHandoff([run]);
    expect(output).not.toContain('Outcome:');
    expect(output).not.toContain('Risks:');
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
      singleMaxBytes: 6 * 1024,
      aggregateMaxBytes: 16 * 1024,
      perTaskMaxBytes: 4 * 1024,
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

  test('preserves every continuation when the envelope alone outgrows the cap', () => {
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
    // 20 tokens at their maximum length outrun the aggregate cap on their own.
    // Metadata is mandatory, so the handoff overflows rather than dropping a
    // continuation the parent would need to resume the task.
    const output = buildParentHandoff(runs);
    expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(
      PARENT_HANDOFF_CAPS.aggregateMaxBytes,
    );
    expect(output).toContain('Mandatory metadata exceeds');
    for (const continuation of continuations)
      expect(output).toContain(`Continuation: ${continuation}`);

    // A fan of the same width with ordinary tokens and ordinary reports has
    // room to spare, so the overflow above is the pathological case it looks
    // like and not the shape of a normal parallel handoff.
    const ordinary = Array.from({ length: 20 }, (_, index) => {
      const run = createRun(`task ${index + 1}`, undefined, {
        continuation: `019fa7a1-f481-75f5-a837-95f6bd24fc${index.toString().padStart(2, '0')}`,
      });
      run.exitCode = 0;
      run.state = 'success';
      run.messages = [
        {
          ...assistantMessage,
          content: [
            {
              type: 'text',
              text: `Outcome: done\n\nConclusion: task ${index + 1} is fine\n\nEvidence:\n- src/module-${index}.ts:12 guards the path`,
            },
          ],
        } as never,
      ];
      return run;
    });
    expect(
      Buffer.byteLength(buildParentHandoff(ordinary), 'utf8'),
    ).toBeLessThanOrEqual(PARENT_HANDOFF_CAPS.aggregateMaxBytes);
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
