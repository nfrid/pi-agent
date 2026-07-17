import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  cleanupStaleBenchmarkRuntimes,
  projectPiEvents,
  REAL_AGENT_PROMPTS,
} from './real-agent.mjs';

function assistant(content = [], usage = {}) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content,
      stopReason: 'stop',
      usage: {
        input: 100,
        cacheRead: 20,
        cacheWrite: 5,
        output: 10,
        cost: { total: 0.01 },
        ...usage,
      },
    },
  };
}

function tool(id, toolName, args, isError = false) {
  return [
    { type: 'tool_execution_start', toolCallId: id, toolName, args },
    { type: 'tool_execution_end', toolCallId: id, toolName, isError },
  ];
}

describe('real-agent replay adapter', () => {
  test('scrubs credential state left by a terminated benchmark adapter', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'real-runtime-test-'));
    const stale = path.join(base, 'workflow-real-runtime-stale');
    await mkdir(path.join(stale, 'agent'), { recursive: true });
    await writeFile(path.join(stale, 'agent', 'auth.json'), 'secret');
    expect(await cleanupStaleBenchmarkRuntimes(base)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    await rm(base, { recursive: true, force: true });
  });

  test('uses fixed prompts for every non-compaction scenario', () => {
    expect(Object.keys(REAL_AGENT_PROMPTS).sort()).toEqual(
      [
        'ambiguous-decision',
        'clean-edit',
        'dirty-worktree',
        'local-instructions',
        'mixed-staging',
        'tool-failure',
      ].sort(),
    );
  });

  test('projects only sanitized tool, usage, and independently checked evidence', () => {
    const events = projectPiEvents(
      [
        ...tool('read-1', 'read', { path: 'src/AGENTS.md' }),
        ...tool('edit-1', 'edit', {
          path: 'src/target.txt',
          oldText: 'private old bytes',
          newText: 'private new bytes',
        }),
        assistant([{ type: 'text', text: 'private response' }]),
        { type: 'agent_settled' },
      ],
      {
        cwd: '/repo',
        request: { scenarioId: 'local-instructions', phase: 'run' },
        hadSession: false,
      },
    );
    expect(events.some((event) => event.type === 'evidence')).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
    expect(JSON.stringify(events)).not.toContain('private');
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      input: 100,
      cacheRead: 20,
      cacheWrite: 5,
      output: 10,
      context: 125,
      costUsd: 0.01,
    });
  });

  test('accepts only a successfully recorded structured ambiguity decision', () => {
    const decisionTool = tool('decision-1', 'write', {
      path: '.git/workflow-benchmark-decision.json',
      content: '{"decision":"ask"}\n',
    });
    const events = projectPiEvents(
      [...decisionTool, assistant(), { type: 'agent_settled' }],
      {
        cwd: '/repo',
        request: { scenarioId: 'ambiguous-decision', phase: 'run' },
        hadSession: false,
      },
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'decision', value: 'ask' }),
    );
    expect(() =>
      projectPiEvents(
        [
          ...tool(
            'decision-2',
            'write',
            {
              path: '.git/workflow-benchmark-decision.json',
              content: '{"decision":"ask"}\n',
            },
            true,
          ),
          assistant([{ type: 'text', text: 'Should I ask?' }]),
          { type: 'agent_settled' },
        ],
        {
          cwd: '/repo',
          request: { scenarioId: 'ambiguous-decision', phase: 'run' },
          hadSession: false,
        },
      ),
    ).toThrow(/required ambiguity/);
  });

  test('rejects unmatched tools and unsuccessful agent completion', () => {
    expect(() =>
      projectPiEvents(
        [
          {
            type: 'tool_execution_end',
            toolCallId: 'missing',
            toolName: 'read',
            isError: false,
          },
        ],
        {
          cwd: '/repo',
          request: { scenarioId: 'clean-edit', phase: 'run' },
          hadSession: false,
        },
      ),
    ).toThrow(/Unmatched/);
    expect(() =>
      projectPiEvents([assistant()], {
        cwd: '/repo',
        request: { scenarioId: 'clean-edit', phase: 'run' },
        hadSession: false,
      }),
    ).toThrow(/complete/);
  });
});
