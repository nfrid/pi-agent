import { describe, expect, test, vi } from 'vitest';
import * as delegateChild from './delegate-child';
import { processJsonLine } from './events';
import { DelegateJobManager } from './jobs';
import {
  LIFECYCLE_INLINE_DIAGNOSTIC_BYTES,
  LIFECYCLE_PUBLIC_FALLBACK_MARKER,
  setDelegateLifecycle,
  setDelegateLifecycleDiagnosticArtifact,
} from './lifecycle';
import { buildParentHandoff, PARENT_HANDOFF_CAPS } from './output';
import { runDelegate } from './runner';
import { DelegateStatusStore } from './status';
import {
  captureDelegateResultEvent,
  getDelegateResultSpec,
  normalizeDelegateResultSpec,
  setDelegateResultSpec,
  settleDelegateResult,
} from './structured-result';
import {
  buildArtifactBackedHandoff,
  buildSessionBoundArtifactBackedHandoff,
  delegateToolResult,
  makeDetails,
} from './tool-result';
import { createRun } from './types';

function metadata(handle: string, size: number) {
  return {
    handle,
    sha256: 'a'.repeat(64),
    size,
    producer: 'delegate' as const,
    contentClass: 'delegate-output' as const,
    mediaType: 'application/json; charset=utf-8',
    creationSource: 'delegate.result',
    encoding: 'utf-8' as const,
    lineCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('structured delegate output handoff', () => {
  test('keeps exact result artifact-only and publishes a named view registry entry', async () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          secret: { type: 'string' },
        },
        required: ['title', 'secret'],
      },
      projection: ['/title'],
      views: { secret: '/secret' },
    });
    const run = createRun('structured');
    run.state = 'success';
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(
      run,
      { details: { title: 'visible title', secret: 'artifact-only secret' } },
      false,
    );
    settleDelegateResult(run);
    const entries: unknown[] = [];
    const pi = {
      appendEntry(type: string, data: unknown) {
        entries.push({ type, data });
      },
    } as never;
    let putCalls = 0;
    const put = async (
      _pi: unknown,
      _ctx: unknown,
      input: { bytes: string },
      options?: { delegateView?: { name: string; path: string } },
    ) => {
      putCalls++;
      if (options?.delegateView)
        entries.push({ type: 'artifact-view:v1', data: options.delegateView });
      return metadata(
        `art_${String(putCalls).padStart(22, 'a')}`,
        Buffer.byteLength(input.bytes),
      );
    };
    const ctx = {
      sessionManager: { getSessionId: () => 'owner' },
    } as never;
    const handoff = await buildArtifactBackedHandoff(
      pi,
      ctx,
      [run],
      put as never,
    );
    expect(handoff).toContain('Projection: {"title":"visible title"}');
    expect(handoff).not.toContain('artifact-only secret');
    expect(JSON.stringify({ mode: 'single', runs: [run] })).not.toContain(
      'artifact-only secret',
    );
    expect(makeDetails('single', [run]).runs[0]?.structuredResult).toEqual({
      valid: true,
      value: { title: 'visible title' },
      errors: [],
    });
    expect(JSON.stringify(makeDetails('single', [run]))).not.toContain(
      'artifact-only secret',
    );
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).toContain('secret');
  });

  test('does not put a persisted structured value into parent handoff without its private spec', () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: { secret: { type: 'string' } },
        required: ['secret'],
      },
    });
    if (!spec) throw new Error('expected normalized result spec');
    const run = createRun('persisted structured value');
    run.state = 'success';
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(
      run,
      { details: { secret: 'full value must stay out of parent handoff' } },
      false,
    );
    settleDelegateResult(run);

    const persistedRun = JSON.parse(
      JSON.stringify(makeDetails('single', [run])),
    ).runs[0];
    expect(getDelegateResultSpec(persistedRun)).toBeUndefined();
    const handoff = buildParentHandoff([persistedRun]);
    expect(handoff).toContain('Structured result: valid');
    expect(handoff).not.toContain('full value must stay out of parent handoff');
    expect(handoff).not.toContain('Projection:');
  });

  test('suppresses structured child prose from foreground progress updates', async () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    });
    if (!spec) throw new Error('expected normalized result spec');
    const updates: Array<{ content: Array<{ text: string }> }> = [];
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockImplementation(
      async (run) => {
        run.messages = [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'earlier foreground secret' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'terminal foreground secret' }],
          },
        ] as never;
        run.stderr = 'foreground stderr secret';
        run.activities.push({
          type: 'tool',
          label: 'delegate_result',
          status: 'completed',
        });
        captureDelegateResultEvent(run, { details: { ok: true } }, false);
        return { exitCode: 0, wasAborted: false, timedOut: false };
      },
    );
    try {
      const run = await runDelegate({
        cwd: '/tmp',
        task: 'foreground structured task',
        context: 'fresh',
        sessionPath: '/tmp/structured-progress-session.jsonl',
        isolation: 'shared',
        resultSpec: spec,
        timeoutMs: 5_000,
        maxConcurrency: 1,
        mode: 'single',
        onUpdate: (partial) => updates.push(partial),
      });
      const progress = updates.flatMap((update) =>
        update.content.map((part) => part.text),
      );
      expect(progress.join('\n')).not.toMatch(
        /earlier foreground secret|terminal foreground secret|foreground stderr secret/,
      );
      expect(progress.some((text) => text.includes('delegate_result'))).toBe(
        true,
      );
      expect(JSON.stringify(updates)).not.toMatch(
        /earlier foreground secret|terminal foreground secret|foreground stderr secret/,
      );
      expect(run.state).toBe('success');
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('does not respawn a clean child when its structured channel is missing', async () => {
    const spec = normalizeDelegateResultSpec({
      shape: { ok: 'boolean' },
      projection: 'all',
    });
    if (!spec) throw new Error('expected normalized result spec');
    const spawn = vi
      .spyOn(delegateChild, 'spawnDelegateChild')
      .mockImplementation(async (run) => {
        run.messages = [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I finished but forgot the tool.' },
            ],
          },
        ] as never;
        return { exitCode: 0, wasAborted: false, timedOut: false };
      });
    try {
      const run = await runDelegate({
        cwd: '/tmp',
        task: 'structured repair task',
        context: 'fresh',
        sessionPath: '/tmp/structured-repair-session.jsonl',
        isolation: 'shared',
        resultSpec: spec,
        timeoutMs: 5_000,
        maxConcurrency: 1,
        mode: 'single',
      });
      const handoff = buildParentHandoff([run]);
      expect(spawn).toHaveBeenCalledOnce();
      expect(run.state).toBe('error');
      expect(handoff).toContain('delegate_result channel is missing');
      expect(handoff).not.toContain('forgot the tool');
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('uses only the lifecycle diagnostic when a structured child omits its channel', async () => {
    const spec = normalizeDelegateResultSpec({
      shape: { ok: 'boolean' },
      projection: 'all',
    });
    if (!spec) throw new Error('expected normalized result spec');
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockImplementation(
      async (run) => {
        run.messages = [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Recovery explanation without the required tool.',
              },
            ],
          },
        ] as never;
        return { exitCode: 0, wasAborted: false, timedOut: false };
      },
    );
    try {
      const run = await runDelegate({
        cwd: '/tmp',
        task: 'structured repair failure',
        context: 'fresh',
        sessionPath: '/tmp/structured-repair-failure.jsonl',
        isolation: 'shared',
        resultSpec: spec,
        timeoutMs: 5_000,
        maxConcurrency: 1,
        mode: 'single',
      });
      const handoff = buildParentHandoff([run]);
      expect(run.state).toBe('error');
      expect(handoff).toContain('delegate_result channel is missing');
      expect(handoff).not.toContain(
        'Recovery explanation without the required tool.',
      );
      expect(handoff).not.toContain('Unvalidated child prose');
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('sanitizes structured runs across details, jobs, status, and sessions', async () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: {
          public: { type: 'string' },
          secret: { type: 'string' },
        },
        required: ['public', 'secret'],
      },
      projection: ['/public'],
    });
    if (!spec) throw new Error('expected normalized result spec');
    const run = createRun('public structured result');
    run.state = 'success';
    run.messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'earlier-child-secret' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'terminal-child-secret' }],
      },
    ] as never;
    run.stderr = 'stderr-child-secret';
    run.artifact = metadata(`art_${'a'.repeat(22)}`, 20);
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'structured child thinking',
        },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'normal-1',
        toolName: 'bash',
        args: { command: 'printf structured' },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'normal-1',
        toolName: 'bash',
        result: { output: 'structured output', exitCode: 0 },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'result-1',
        toolName: 'delegate_result',
        result: {
          details: {
            public: 'structured-result-public',
            secret: 'structured-result-secret',
          },
        },
        isError: false,
      }),
      run,
    );
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(
      run,
      {
        details: {
          public: 'structured-result-public',
          secret: 'structured-result-secret',
        },
      },
      false,
    );
    settleDelegateResult(run);

    const details = makeDetails('single', [run]);
    const publicActivities = details.runs[0]?.activities ?? [];
    expect(publicActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          transcriptText: 'structured child thinking',
        }),
        expect.objectContaining({
          type: 'tool',
          toolName: 'bash',
          toolArguments: { command: 'printf structured' },
          toolResult: { output: 'structured output', exitCode: 0 },
        }),
      ]),
    );
    const terminal = publicActivities.find(
      (activity) => activity.toolName === 'delegate_result',
    );
    expect(terminal).toBeDefined();
    expect(terminal).not.toHaveProperty('toolArguments');
    expect(terminal).not.toHaveProperty('toolResult');
    expect(JSON.stringify(details)).toContain('structured-result-public');
    expect(JSON.stringify(details)).not.toContain('structured-result-secret');
    expect(JSON.stringify(details)).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret/,
    );
    expect(JSON.stringify(details)).toContain('structured child thinking');
    expect(JSON.stringify(details)).toContain('structured output');
    const statuses = new DelegateStatusStore();
    statuses.start([run], 'foreground');
    statuses.update('ds-1', run);
    expect(JSON.stringify(statuses.list())).toContain(
      'structured-result-public',
    );
    expect(JSON.stringify(statuses.list())).not.toContain(
      'structured-result-secret',
    );
    expect(JSON.stringify(statuses.list())).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret/,
    );
    expect(JSON.stringify(statuses.list())).toContain('structured output');

    const jobs = new DelegateJobManager();
    const started = jobs.start({
      name: 'Structured job',
      mode: 'single',
      tasks: [run.task],
      execute: async () => ({ runs: [run], handoff: 'bounded' }),
    });
    const completed = await jobs.peek(started.id, 1_000);
    expect(JSON.stringify(completed)).toContain('structured-result-public');
    expect(JSON.stringify(completed)).not.toContain('structured-result-secret');
    expect(JSON.stringify(completed)).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret/,
    );
    expect(JSON.stringify(completed)).toContain('structured child thinking');
    expect(JSON.stringify(completed)).toContain('structured output');
    await jobs.dispose();

    const ownerCtx = {
      sessionManager: { getSessionId: () => 'owner-session' },
    } as never;
    const ownerResult = await delegateToolResult(
      {} as never,
      ownerCtx,
      'single',
      [run],
      'owner-session',
    );
    expect(JSON.stringify(ownerResult.details)).toContain(
      'structured-result-public',
    );
    expect(JSON.stringify(ownerResult.details)).not.toContain(
      'structured-result-secret',
    );
    expect(JSON.stringify(ownerResult.details)).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret/,
    );
    const foreignCtx = {
      sessionManager: { getSessionId: () => 'foreign-session' },
    } as never;
    const foreignResult = await delegateToolResult(
      {} as never,
      foreignCtx,
      'single',
      [run],
      'owner-session',
    );
    expect(JSON.stringify(foreignResult.details)).toContain(
      'structured-result-public',
    );
    expect(JSON.stringify(foreignResult.details)).not.toContain(
      'structured-result-secret',
    );
    expect(JSON.stringify(foreignResult.details)).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret/,
    );
    expect(foreignResult.details?.runs[0]?.artifact).toBeUndefined();
  });

  test('rejects background publication after the owner session switches', async () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: { secret: { type: 'string' } },
        required: ['secret'],
      },
    });
    if (!spec) throw new Error('expected normalized result spec');
    const run = createRun('background structured result');
    run.state = 'success';
    run.messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'stale-structured-prose' }],
      },
    ] as never;
    run.stderr = 'stale-structured-stderr';
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(
      run,
      { details: { secret: 'owner-only background result' } },
      false,
    );
    settleDelegateResult(run);
    const ctx = {
      sessionManager: { getSessionId: () => 'other-session' },
    } as never;
    const handoff = await buildSessionBoundArtifactBackedHandoff(
      {} as never,
      ctx,
      'owner-session',
      [run],
    );
    expect(handoff).not.toMatch(
      /owner-only background result|stale-structured-prose|stale-structured-stderr/,
    );
    expect(handoff).not.toContain('Artifact:');
    expect(run.artifact).toBeUndefined();
  });

  test('stale foreground details carry the bounded fallback without the owner handle', async () => {
    const run = createRun('stale foreground failure');
    run.state = 'error';
    run.exitCode = 7;
    run.stderr = 'raw stale stderr must never cross the session boundary';
    const diagnostic = `exact owner diagnostic ${'界'.repeat(2_000)}`;
    setDelegateLifecycle(run, 'child-nonzero-exit', diagnostic);
    const ownerArtifact = metadata(
      `art_${'o'.repeat(22)}`,
      Buffer.byteLength(diagnostic),
    );
    setDelegateLifecycleDiagnosticArtifact(run, ownerArtifact);

    const result = await delegateToolResult(
      {} as never,
      { sessionManager: { getSessionId: () => 'stale-session' } } as never,
      'single',
      [run],
      'owner-session',
    );
    const staleRun = result.details.runs[0];
    expect(staleRun?.lifecycle?.reason).toBe('child-nonzero-exit');
    expect(staleRun?.lifecycle?.diagnostic).toContain(
      LIFECYCLE_PUBLIC_FALLBACK_MARKER,
    );
    expect(
      Buffer.byteLength(staleRun?.lifecycle?.diagnostic ?? '', 'utf8'),
    ).toBeLessThanOrEqual(LIFECYCLE_INLINE_DIAGNOSTIC_BYTES);
    expect(staleRun?.lifecycle?.diagnosticArtifact).toBeUndefined();
    expect(
      Buffer.byteLength(result.content[0]?.text ?? '', 'utf8'),
    ).toBeLessThanOrEqual(PARENT_HANDOFF_CAPS.singleMaxBytes);
    expect(JSON.stringify(result)).not.toContain(ownerArtifact.handle);
    expect(JSON.stringify(result)).not.toContain('raw stale stderr');
  });

  test('legacy output remains prose-shaped when no result contract is present', () => {
    const run = createRun('legacy');
    run.state = 'success';
    run.messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Outcome: done\nConclusion: prose' }],
      },
    ] as never;
    const handoff = buildParentHandoff([run]);
    expect(handoff).toContain('Outcome: done');
    expect(handoff).toContain('Conclusion: prose');
    expect(handoff).not.toContain('Structured result:');
  });
});
