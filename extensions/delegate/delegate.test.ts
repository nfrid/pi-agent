import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
  getAgentDir,
  initTheme,
  type ThemeColor,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test, vi } from 'vitest';
import { buildSystemPrompt } from '../system-prompt';
import {
  canonicalizeEffort,
  normalizeEffortProfiles,
  parseDelegateConfig,
  resolveEffort,
} from './config';
import { processJsonLine } from './events';
import { buildArtifactBackedHandoff, prepareDelegateArguments } from './index';
import {
  buildParentHandoff,
  PARENT_HANDOFF_CAPS,
  truncateBytes,
} from './output';
import { buildDelegatePrompt } from './prompt';
import { renderDelegateCall, renderDelegateResult } from './render';
import { buildChildArgs, resolvePiSpawn } from './runner';
import {
  buildSessionSnapshotJsonl,
  createDelegateSession,
  resolveDelegateSession,
} from './session';
import { createRun, getFinalAssistantText, getRunState } from './types';

initTheme('dark', false);

const theme = {
  fg: (_color: ThemeColor, text: string) => text,
  bold: (text: string) => text,
};

const assistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  usage: {
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
  },
};

describe('delegate', () => {
  test('defaults children to read-only work without a rigid report format', () => {
    const prompt = buildDelegatePrompt('Inspect the repository');
    expect(prompt).toMatch(/read-only task/);
    expect(prompt).not.toMatch(/Use this exact structure/);
  });

  test('adds curated context, advisory scope, and continuation framing', () => {
    const prompt = buildDelegatePrompt('Recheck the failure', {
      contextNote: 'The parser path is already ruled out.',
      scope: ['src/cache', 'tests/cache'],
      continuation: true,
    });
    expect(prompt).toContain('Context from the parent agent');
    expect(prompt).toContain('parser path is already ruled out');
    expect(prompt).toContain('guidance, not a hard boundary');
    expect(prompt).toContain('follow-up feedback');
  });

  test('does not duplicate agent_end messages received through message_end', () => {
    const run = createRun('test');
    expect(
      processJsonLine(
        JSON.stringify({ type: 'message_end', message: assistantMessage }),
        run,
      ),
    ).toBe(true);
    expect(
      processJsonLine(
        JSON.stringify({ type: 'agent_end', messages: [assistantMessage] }),
        run,
      ),
    ).toBe(false);
    expect(run.messages).toHaveLength(1);
    expect(run.usage.turns).toBe(1);
  });

  test('uses agent_end as a fallback when message_end events are absent', () => {
    const run = createRun('test');
    expect(
      processJsonLine(
        JSON.stringify({ type: 'agent_end', messages: [assistantMessage] }),
        run,
      ),
    ).toBe(true);
    expect(run.messages).toHaveLength(1);
    expect(run.usage.turns).toBe(1);
  });

  test('uses one configured provider for economy effort profiles', () => {
    expect(
      resolveEffort('economy', {
        provider: 'openai-codex',
        effortProfiles: {
          economy: { model: 'quick', thinking: 'high' },
        },
      }),
    ).toEqual({
      selected: 'economy',
      provider: 'openai-codex',
      profile: { model: 'quick', thinking: 'high' },
    });
    expect(resolveEffort('deep', { provider: 'openai-codex' }).error).toMatch(
      /not fully configured/,
    );
  });

  test('maps legacy fast effort settings and stored tool calls to economy', () => {
    expect(canonicalizeEffort('fast')).toBe('economy');
    expect(
      normalizeEffortProfiles({
        fast: { model: 'legacy-quick', thinking: 'high' },
      }),
    ).toEqual({
      economy: { model: 'legacy-quick', thinking: 'high' },
    });
    expect(
      resolveEffort('fast', {
        provider: 'openai-codex',
        effortProfiles: {
          economy: { model: 'quick', thinking: 'high' },
        },
      }),
    ).toMatchObject({ selected: 'economy' });
    expect(
      prepareDelegateArguments({
        effort: 'fast',
        tasks: [{ task: 'one' }, { task: 'two', effort: 'fast' }],
      }),
    ).toEqual({
      effort: 'economy',
      tasks: [{ task: 'one' }, { task: 'two', effort: 'economy' }],
    });
    const legacyCall = renderDelegateCall(
      { task: 'legacy', effort: 'fast' },
      theme,
      { cwd: '/tmp/project' },
    );
    expect(legacyCall.render(200).join('\n')).toContain('Eco');
  });

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

  test('runtime configuration errors block effort resolution', () => {
    const runtimeInvalid = parseDelegateConfig({
      timeoutMs: 1,
      provider: 'openai-codex',
      effortProfiles: {
        economy: { model: 'quick', thinking: 'high' },
      },
    });
    expect(resolveEffort('economy', runtimeInvalid).error).toContain(
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

  test('preserves 20 maximum-length opaque continuations within production caps', () => {
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
    expect(impossible).toContain('Mandatory envelope exceeds');
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

  test('snapshots the branch before the current delegate call and overrides cwd', () => {
    expect(
      buildSessionSnapshotJsonl(
        {
          getHeader: () => ({ type: 'session', id: 'abc', cwd: '/old' }),
          getBranch: () => [
            { type: 'message', id: 'one' },
            {
              type: 'message',
              id: 'current',
              message: {
                role: 'assistant',
                content: [{ type: 'toolCall', id: 'call-1' }],
              },
            },
          ],
        },
        { cwd: '/new', excludeToolCallId: 'call-1' },
      ),
    ).toBe(
      '{"type":"session","id":"abc","cwd":"/new"}\n{"type":"message","id":"one"}\n',
    );
  });

  test('creates durable opaque sessions that can be resolved for continuation', () => {
    const session = createDelegateSession({ cwd: '/tmp/project' });
    try {
      expect(resolveDelegateSession(session.token)).toEqual(session);
      const header = JSON.parse(
        readFileSync(session.filePath, 'utf8').trim(),
      ) as Record<string, unknown>;
      expect(header).toMatchObject({
        type: 'session',
        id: session.token,
        cwd: '/tmp/project',
      });
      expect(resolveDelegateSession('../../not-a-token')).toBeNull();
    } finally {
      const dir = path.join(getAgentDir(), '.delegate-sessions');
      rmSync(path.join(dir, `${session.token}.jsonl`), { force: true });
      rmSync(path.join(dir, `${session.token}.json`), { force: true });
    }
  });

  test('resolves delegate children through PATH instead of a stale parent script', () => {
    expect(resolvePiSpawn()).toEqual({ command: 'pi', prefixArgs: [] });
  });

  test('uses persistent, minimal, read-only children with the system prompt extension', () => {
    const args = buildChildArgs({ task: 'inspect' }, '/tmp/child.jsonl');
    expect(args).toContain('--session');
    expect(args[args.indexOf('--session') + 1]).toBe('/tmp/child.jsonl');
    expect(args).toContain('--no-extensions');
    const extensionPath = args[args.indexOf('--extension') + 1];
    expect(extensionPath).toMatch(
      /extensions[\\/]system-prompt[\\/]index\.ts$/,
    );
    expect(existsSync(extensionPath)).toBe(true);
    expect(args[args.indexOf('--tools') + 1]).toBe('read,bash,grep,find,ls');
  });

  test('gives delegate children a focused role without changing the main role', () => {
    const options = {
      cwd: '/tmp/project',
      selectedTools: ['read'],
      toolSnippets: { read: 'Read files' },
    } as never;
    expect(buildSystemPrompt(options, 'json', true)).toContain(
      'focused coding subagent',
    );
    expect(buildSystemPrompt(options, 'tui', false)).toContain(
      'expert coding assistant',
    );
    expect(
      buildSystemPrompt(
        {
          cwd: '/tmp/project',
          customPrompt: 'A carefully customized prompt',
        } as never,
        'json',
        true,
      ),
    ).toContain('Delegated child context');
  });

  test('enables mutation tools only when explicitly requested', () => {
    const args = buildChildArgs(
      { task: 'implement', allowWrites: true },
      '/tmp/child.jsonl',
    );
    expect(args[args.indexOf('--tools') + 1]).toContain('write');
    expect(args[args.indexOf('--tools') + 1]).toContain('bash');
  });

  test('joins all text blocks in the final assistant response', () => {
    expect(
      getFinalAssistantText([
        {
          ...assistantMessage,
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        } as never,
      ]),
    ).toBe('first\nsecond');
  });

  test('tracks effective scope and lifecycle state', () => {
    const run = createRun('inspect', undefined, {
      cwd: '/tmp/project',
      context: 'branch',
      allowWrites: true,
    });
    expect(run).toMatchObject({
      state: 'queued',
      cwd: '/tmp/project',
      context: 'branch',
      allowWrites: true,
    });
    expect(getRunState(run)).toBe('queued');
    expect(getRunState({ ...run, state: undefined, exitCode: 124 })).toBe(
      'timed-out',
    );
  });

  test('renders labelled parallel tasks with plain-language modes', () => {
    const component = renderDelegateCall(
      {
        tasks: [
          { task: 'inspect' },
          { task: 'implement', allowWrites: true, context: 'branch' },
        ],
        cwd: '/tmp/project',
        context: 'fresh',
        effort: 'economy',
      },
      theme,
      { cwd: '/tmp/project' },
    );
    const output = component.render(300).join('\n');
    expect(output).toContain('Delegate · 2 subagents');
    expect(output).toContain('1 Task  inspect');
    expect(output).toContain('Fresh context · Read-only · /tmp/project · Eco');
    expect(output).toContain('2 Task  implement');
    expect(output).toContain('Parent context · Can edit · /tmp/project');
  });

  test('shows the full delegated prompt when the call is expanded', () => {
    const prompt = `Inspect the project and report ${'all relevant details '.repeat(20)}`;
    const component = renderDelegateCall({ task: prompt }, theme, {
      cwd: '/tmp/project',
      expanded: true,
    });
    expect(component.render(1000).join('\n')).toContain(prompt.trim());
  });

  test('lets result details own the card after execution starts', () => {
    const component = renderDelegateCall(
      { task: 'Inspect the project' },
      theme,
      { cwd: '/tmp/project', executionStarted: true },
    );
    expect(component.render(100)).toEqual([]);
  });

  test('preserves detailed tool labels when end events omit args', () => {
    const run = createRun('inspect');
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'read-1',
        toolName: 'read',
        args: { path: '/tmp/project/file.ts' },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'contents' }] },
      }),
      run,
    );
    expect(run.activities[0]).toMatchObject({
      label: 'read /tmp/project/file.ts',
      status: 'completed',
    });
  });

  test('uses the first thinking text as an activity title', () => {
    const run = createRun('inspect');
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'I should inspect the type definitions first.',
        },
      }),
      run,
    );
    expect(run.activities[0]?.label).toBe(
      'thinking: I should inspect the type definitions first.',
    );
  });

  test('shows only a GPT-style bold thinking title', () => {
    const run = createRun('inspect');
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta:
            '**Thinking about oranges.**\n<!-- -->\nThe rest should stay hidden.',
        },
      }),
      run,
    );
    expect(run.activities[0]?.label).toBe('Thinking about oranges.');
  });

  test('keeps grouped thinking titles in chronological activity order', () => {
    const run = createRun('inspect');
    const thinkingEvent = (
      type: string,
      values: Record<string, unknown> = {},
    ) =>
      processJsonLine(
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type, contentIndex: 0, ...values },
        }),
        run,
      );

    thinkingEvent('thinking_start');
    thinkingEvent('thinking_delta', { delta: '**One trace**' });
    thinkingEvent('thinking_delta', {
      delta: '**One trace** **Another trace**',
    });
    thinkingEvent('thinking_delta', {
      delta: '**One trace** **Another trace** **Third trace**',
    });
    thinkingEvent('thinking_end');
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        toolName: 'read',
      }),
      run,
    );
    thinkingEvent('thinking_start');
    thinkingEvent('thinking_delta', {
      delta: '**A trace from the next group**',
    });
    thinkingEvent('thinking_end');

    expect(run.activities.map((activity) => activity.label)).toEqual([
      'One trace',
      'Another trace',
      'Third trace',
      'read',
      'A trace from the next group',
    ]);

    const styledTheme = {
      fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const output = renderDelegateResult(
      { details: { mode: 'single', runs: [run] } },
      { expanded: true },
      styledTheme,
    )
      .render(300)
      .join('\n');
    expect(output).toContain('<thinkingText>Another trace</thinkingText>');
    expect(output).not.toContain('<dim>Another trace</dim>');
    expect(output).not.toContain('**One trace** **Another trace**');
  });

  test('renders a task-first running hierarchy and dims tool metadata', () => {
    const run = createRun('Inspect the cache invalidation path', undefined, {
      cwd: '/tmp/project',
      context: 'fresh',
    });
    run.state = 'running';
    run.activities.push({
      type: 'tool',
      label: 'read /tmp/project/file.ts',
      status: 'running',
    });
    const styledTheme = {
      fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const component = renderDelegateResult(
      { details: { mode: 'single', runs: [run] } },
      { expanded: false },
      styledTheme,
    );
    const output = component.render(300).join('\n');
    expect(output).toContain('<toolTitle>Delegate</toolTitle>');
    expect(output).toContain(
      '<text>Inspect the cache invalidation path</text>',
    );
    expect(output).toContain('<success>read</success>');
    expect(output).toContain('<dim> /tmp/project/file.ts</dim>');
    expect(output).toContain(
      '<dim>Fresh context</dim><dim> · </dim><dim>Read-only</dim>',
    );
    expect(output).toContain('cancel');
  });

  test('dims routine startup and running status', () => {
    const run = createRun(
      'Inspect the project',
      {
        selected: 'economy',
        provider: 'openai-codex',
        profile: { model: 'gpt-5.6-terra', thinking: 'medium' },
      },
      {
        cwd: '/tmp/project',
        context: 'fresh',
      },
    );
    run.state = 'running';
    const styledTheme = {
      fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const output = renderDelegateResult(
      { details: { mode: 'single', runs: [run] } },
      { expanded: false },
      styledTheme,
    )
      .render(300)
      .join('\n');
    expect(output).toContain('<muted>…</muted>');
    expect(output).toContain('<dim>Starting subagent</dim>');
    expect(output).toContain('<success>Eco</success>');
    expect(output).not.toContain('<warning>…</warning>');
  });

  test('color-codes effort profiles and elevated write access', () => {
    const styledTheme = {
      fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    for (const [effort, color, label] of [
      ['economy', 'success', 'Eco'],
      ['balanced', 'accent', 'Balanced'],
      ['deep', 'warning', 'Deep'],
    ] as const) {
      const output = renderDelegateCall(
        { task: 'inspect', effort, allowWrites: true },
        styledTheme,
        { cwd: '/tmp/project' },
      )
        .render(300)
        .join('\n');
      expect(output).toContain(`<${color}>${label}</${color}>`);
      expect(output).toContain('<warning>Can edit</warning>');
    }
  });

  test('shows effort profiles instead of model names in result views', () => {
    const run = createRun(
      'Inspect the project',
      {
        selected: 'balanced',
        provider: 'openai-codex',
        profile: { model: 'gpt-5.6-terra', thinking: 'medium' },
      },
      { cwd: '/tmp/project', context: 'fresh' },
    );
    run.state = 'success';
    run.exitCode = 0;
    run.model = 'gpt-5.6-terra';
    run.messages = [assistantMessage as never];
    run.finishedAt = Date.now();
    for (const expanded of [false, true]) {
      const output = renderDelegateResult(
        { details: { mode: 'single', runs: [run] } },
        { expanded },
        theme,
      )
        .render(300)
        .join('\n');
      const modeLine = output
        .split('\n')
        .find((line) => line.includes('Fresh context · Read-only'));
      expect(modeLine).toContain('Balanced');
      expect(output).not.toContain('gpt-5.6-terra');
      expect(output).not.toMatch(/Balanced effort/);
      expect(output).not.toMatch(/\n[ \t]*\nResult/);
    }
  });

  test('organizes expanded output into explicit sections', () => {
    const run = createRun('Recheck the cache fix', undefined, {
      cwd: '/tmp/project',
      context: 'continuation',
      continuation: 'child-token',
      contextNote: 'The parser has already been ruled out.',
      scope: ['src/cache'],
    });
    run.state = 'success';
    run.exitCode = 0;
    run.messages = [assistantMessage as never];
    run.finishedAt = Date.now();
    const component = renderDelegateResult(
      { details: { mode: 'single', runs: [run] } },
      { expanded: true },
      theme,
    );
    const output = component.render(300).join('\n');
    expect(output).toContain('Task');
    expect(output).toContain('Recheck the cache fix');
    expect(output).toContain('Mode');
    expect(output).toContain('Continued context · Read-only · /tmp/project');
    expect(output).toContain('Advisory scope: src/cache');
    expect(output).toContain(
      'Parent note: The parser has already been ruled out.',
    );
    expect(output).toContain('Result');
    expect(output).toContain('Usage & continuation');
    expect(output).toContain('Continuation: child-token');
  });

  test('keeps the task visible without duplicating a result heading', () => {
    const run = createRun('A unique delegated task', undefined, {
      cwd: '/tmp/project',
      context: 'fresh',
    });
    run.state = 'success';
    run.exitCode = 0;
    run.messages = [
      {
        ...assistantMessage,
        content: [{ type: 'text', text: '## Result\n\n- first\n- second' }],
      } as never,
    ];
    run.finishedAt = Date.now();
    for (const expanded of [false, true]) {
      const component = renderDelegateResult(
        { details: { mode: 'single', runs: [run] } },
        { expanded },
        theme,
      );
      const output = component.render(300).join('\n');
      expect(output).toContain('Delegate · done');
      expect(output).toContain('A unique delegated task');
      expect(output.match(/Result/g)).toHaveLength(1);
      expect(output).toContain('first');
      expect(output).toContain('Fresh context · Read-only · /tmp/project');
    }
  });

  test('renders partial parallel completion prominently', () => {
    const success = createRun('review', undefined, {
      cwd: '/tmp/project',
      context: 'fresh',
    });
    success.state = 'success';
    success.exitCode = 0;
    success.messages = [assistantMessage as never];
    success.finishedAt = Date.now();
    const failure = createRun('test', undefined, {
      cwd: '/tmp/project',
      context: 'fresh',
    });
    failure.state = 'error';
    failure.exitCode = 1;
    failure.errorMessage = 'Tests failed';
    failure.warnings = ['Parallel write scopes overlap.'];
    failure.finishedAt = Date.now();

    const component = renderDelegateResult(
      { details: { mode: 'parallel', runs: [success, failure] } },
      { expanded: false },
      theme,
    );
    const output = component.render(300).join('\n');
    expect(output).toContain('1/2 succeeded');
    expect(output).toContain('Partial success');
    expect(output).toContain('Warning: Parallel write scopes overlap.');
    expect(output).toContain(' 1 ✓ review');
    expect(output).toContain(' 2 × test');
    expect(output).toContain('Tests failed');
  });
});
