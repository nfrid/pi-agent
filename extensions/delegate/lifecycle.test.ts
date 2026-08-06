import { afterEach, describe, expect, test, vi } from 'vitest';
import * as delegateChild from './delegate-child';
import {
  getDelegateLifecycle,
  getDelegateLifecycleDiagnostic,
  LIFECYCLE_INLINE_DIAGNOSTIC_BYTES,
  LIFECYCLE_PUBLIC_FALLBACK_MARKER,
  setDelegateLifecycle,
} from './lifecycle';
import { getDetails } from './render-utils';
import { runDelegate } from './runner';
import { DelegateStatusStore } from './status';
import { serializeDelegateRunForPublic } from './structured-result';
import { buildArtifactBackedHandoff, makeDetails } from './tool-result';
import { createRun } from './types';

function diagnosticArtifact(size: number) {
  return {
    handle: `art_${'f'.repeat(22)}`,
    sha256: 'b'.repeat(64),
    size,
    producer: 'delegate' as const,
    contentClass: 'delegate-output' as const,
    creationSource: 'delegate.failure',
    encoding: 'utf-8' as const,
    lineCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => vi.restoreAllMocks());

describe('delegate lifecycle failure projection', () => {
  test('is harness-authored and ignores a child-shaped lifecycle field', () => {
    const run = createRun('failure');
    run.state = 'error';
    run.errorMessage = 'runner failed';
    (run as unknown as { lifecycle: unknown }).lifecycle = {
      reason: 'user-cancellation',
      diagnostic: 'spoofed',
    };
    setDelegateLifecycle(run, 'provider-runner-error', 'runner failed');

    const details = makeDetails('single', [run]);
    expect(details.runs[0]?.lifecycle).toMatchObject({
      reason: 'provider-runner-error',
      diagnostic: 'runner failed',
    });
    expect(JSON.stringify(details)).not.toContain('spoofed');
  });

  test('retains lifecycle projections across trusted details and status snapshots', () => {
    const run = createRun('durable lifecycle');
    run.state = 'error';
    run.exitCode = 1;
    setDelegateLifecycle(run, 'provider-runner-error', 'runner failed');

    const details = makeDetails('single', [run]);
    const persisted = JSON.parse(JSON.stringify(details));
    const hydrated = getDetails({ details: persisted });
    const hydratedRun = hydrated?.runs[0];
    if (!hydratedRun) throw new Error('missing hydrated run');
    expect(serializeDelegateRunForPublic(hydratedRun).lifecycle).toMatchObject({
      reason: 'provider-runner-error',
      diagnostic: 'runner failed',
    });

    const statuses = new DelegateStatusStore();
    statuses.start([run], 'foreground');
    expect(statuses.list()[0]?.lifecycle).toMatchObject({
      reason: 'provider-runner-error',
      diagnostic: 'runner failed',
    });
  });

  test('does not hydrate an arbitrary child lifecycle field as harness state', () => {
    const run = createRun('spoof');
    run.state = 'error';
    (run as unknown as { lifecycle: unknown }).lifecycle = {
      reason: 'user-cancellation',
      diagnostic: 'child spoof',
      continuationUsable: true,
      writableBranchRetained: true,
      readOnlySnapshotRetained: true,
    };
    const statuses = new DelegateStatusStore();
    statuses.start([run], 'foreground');
    expect(statuses.list()[0]?.lifecycle).toMatchObject({
      reason: 'unknown',
    });
    expect(statuses.list()[0]?.lifecycle?.diagnostic).not.toBe('child spoof');
  });

  test.each([
    [
      'user cancellation',
      { exitCode: 130, wasAborted: true, timedOut: false },
      'user-cancellation',
    ],
    [
      'timeout',
      { exitCode: 124, wasAborted: false, timedOut: true },
      'timeout',
    ],
    [
      'child exit',
      { exitCode: 7, wasAborted: false, timedOut: false },
      'child-nonzero-exit',
    ],
  ] as const)('classifies observed %s', async (_label, result, reason) => {
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockResolvedValue(result);
    const run = await runDelegate({
      cwd: '/tmp',
      task: 'classify',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-test.jsonl',
      isolation: 'shared',
      timeoutMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    expect(getDelegateLifecycle(run)?.reason).toBe(reason);
  });

  test('classifies a nonzero exit even when a child error event populated the message', async () => {
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockImplementation(
      async (run) => {
        run.errorMessage = 'provider event says request failed';
        run.stderr = 'raw child stderr must stay bounded evidence';
        return { exitCode: 17, wasAborted: false, timedOut: false };
      },
    );

    const run = await runDelegate({
      cwd: '/tmp',
      task: 'nonzero with event',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-nonzero-event.jsonl',
      isolation: 'shared',
      timeoutMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });

    expect(getDelegateLifecycle(run)).toMatchObject({
      reason: 'child-nonzero-exit',
      diagnostic: expect.stringContaining('provider event says request failed'),
    });
  });

  test('distinguishes queued cancellation, runner exceptions, and unknown throws', async () => {
    const controller = new AbortController();
    controller.abort();
    const queued = await runDelegate({
      cwd: '/tmp',
      task: 'queued',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-queued.jsonl',
      isolation: 'shared',
      timeoutMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
      signal: controller.signal,
    });
    expect(getDelegateLifecycle(queued)?.reason).toBe('queued-cancellation');

    vi.spyOn(delegateChild, 'spawnDelegateChild')
      .mockRejectedValueOnce(new Error('runner exploded'))
      .mockRejectedValueOnce('opaque failure');
    const runner = await runDelegate({
      cwd: '/tmp',
      task: 'runner',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-runner.jsonl',
      isolation: 'shared',
      timeoutMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    const unknown = await runDelegate({
      cwd: '/tmp',
      task: 'unknown',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-unknown.jsonl',
      isolation: 'shared',
      timeoutMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    expect(getDelegateLifecycle(runner)?.reason).toBe('provider-runner-error');
    expect(getDelegateLifecycle(unknown)?.reason).toBe('unknown');
  });

  test('bounds a long diagnostic when lifecycle artifact publication fails', async () => {
    const run = createRun('publication failure');
    run.state = 'error';
    setDelegateLifecycle(run, 'provider-runner-error', '🙂'.repeat(20_000));
    const handoff = await buildArtifactBackedHandoff(
      {} as never,
      {} as never,
      [run],
      async () => {
        throw new Error('publication unavailable');
      },
    );
    const diagnostic = getDelegateLifecycle(run)?.diagnostic ?? '';
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(
      LIFECYCLE_INLINE_DIAGNOSTIC_BYTES,
    );
    expect(diagnostic).toContain(LIFECYCLE_PUBLIC_FALLBACK_MARKER);
    expect(handoff).toContain(LIFECYCLE_PUBLIC_FALLBACK_MARKER);
  });

  test('artifacts an exact long Unicode diagnostic without inline clipping', async () => {
    const run = createRun('long failure');
    run.state = 'error';
    const exact = ['line one', '失敗🙂'.repeat(2_000), 'line three'].join('\n');
    setDelegateLifecycle(run, 'unknown', exact);
    let bytes = '';
    const handoff = await buildArtifactBackedHandoff(
      {} as never,
      {} as never,
      [run],
      async (_pi, _ctx, input) => {
        bytes = String(input.bytes);
        return diagnosticArtifact(Buffer.byteLength(bytes, 'utf8'));
      },
    );

    expect(bytes).toBe(getDelegateLifecycleDiagnostic(run));
    expect(handoff).toContain(
      `Failure artifact: ${diagnosticArtifact(Buffer.byteLength(bytes, 'utf8')).handle}`,
    );
    expect(handoff).not.toContain('失敗🙂'.repeat(100));
    expect(getDelegateLifecycle(run)).toMatchObject({
      reason: 'unknown',
      diagnosticArtifact: expect.objectContaining({
        creationSource: 'delegate.failure',
      }),
    });
  });
});
