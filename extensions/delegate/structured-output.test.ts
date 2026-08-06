import { describe, expect, test } from 'vitest';
import { DelegateJobManager } from './jobs';
import { buildParentHandoff } from './output';
import { DelegateStatusStore } from './status';
import {
  captureDelegateResultEvent,
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
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).toContain('secret');
  });

  test('sanitizes structured runs across details, jobs, status, and sessions', async () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: { secret: { type: 'string' } },
        required: ['secret'],
      },
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
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(
      run,
      { details: { secret: 'structured-result-secret' } },
      false,
    );
    settleDelegateResult(run);

    expect(JSON.stringify(makeDetails('single', [run]))).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret|structured-result-secret/,
    );
    const statuses = new DelegateStatusStore();
    statuses.start([run], 'foreground');
    statuses.update('ds-1', run);
    expect(JSON.stringify(statuses.list())).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret|structured-result-secret/,
    );

    const jobs = new DelegateJobManager();
    const started = jobs.start({
      name: 'Structured job',
      mode: 'single',
      tasks: [run.task],
      execute: async () => ({ runs: [run], handoff: 'bounded' }),
    });
    const completed = await jobs.peek(started.id, 1_000);
    expect(JSON.stringify(completed)).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret|structured-result-secret/,
    );
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
    expect(JSON.stringify(ownerResult.details)).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret|structured-result-secret/,
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
    expect(JSON.stringify(foreignResult.details)).not.toMatch(
      /earlier-child-secret|terminal-child-secret|stderr-child-secret|structured-result-secret/,
    );
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
