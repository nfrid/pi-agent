import { describe, expect, test } from 'vitest';
import { buildParentHandoff } from './output';
import {
  captureDelegateResultEvent,
  normalizeDelegateResultSpec,
  setDelegateResultSpec,
  settleDelegateResult,
} from './structured-result';
import { buildArtifactBackedHandoff } from './tool-result';
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
