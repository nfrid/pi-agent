import { BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES } from '@pi-agent/background-jobs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as harnessTelemetry from '../shared/telemetry';
import * as delegateChild from './delegate-child';
import { processJsonLine } from './events';
import {
  cloneDelegateLifecycle,
  copyDelegateLifecycle,
  getDelegateLifecycle,
  getDelegateLifecycleDiagnostic,
  LIFECYCLE_INLINE_DIAGNOSTIC_BYTES,
  LIFECYCLE_PUBLIC_FALLBACK_MARKER,
  recordDelegateEventOverflow,
  setDelegateLifecycle,
  setDelegateLifecycleText,
} from './lifecycle';
import { getDetails } from './render-utils';
import { runDelegate } from './runner';
import { serializeDelegateRunForPublic } from './serialize';
import { DelegateStatusStore } from './status';
import { buildOutputFileHandoff, makeDetails } from './tool-result';
import { createRun } from './types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('delegate lifecycle failure projection', () => {
  test('finishes and releases the session and launch slot when terminal status observers throw', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spawn = vi
      .spyOn(delegateChild, 'spawnDelegateChild')
      .mockImplementation(async (run) => {
        processJsonLine(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'stop',
              content: [{ type: 'text', text: 'Finished task' }],
            },
          }),
          run,
        );
        return { exitCode: 0, wasAborted: false, timedOut: false };
      });
    const updates: string[] = [];
    const options = {
      cwd: '/tmp',
      task: 'finish despite presentation failure',
      context: 'fresh' as const,
      sessionPath: '/tmp/delegate-status-observer-regression.jsonl',
      isolation: 'shared' as const,
      warningAfterMs: 0,
      maxConcurrency: 1,
      mode: 'single' as const,
      onRunUpdate: (run: ReturnType<typeof createRun>) => {
        if (run.state === 'success')
          throw new Error('Delegate status surface is invalid.');
      },
      onUpdate: (update: import('./types').DelegateProgressUpdate) => {
        const state = update.details?.runs[0]?.state;
        if (state) updates.push(state);
        if (state === 'success') throw new Error('Another failed renderer');
      },
    };
    const first = await runDelegate(options);
    const continuation = await runDelegate(options);
    expect(first.state).toBe('success');
    expect(continuation.state).toBe('success');
    expect(first.finishedAt).toBeDefined();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(updates.filter((state) => state === 'success')).toHaveLength(2);
    expect(diagnostic).toHaveBeenCalledTimes(2);
  });

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

  test('drops removed structured-result fields and activities from public records', () => {
    const run = createRun('stale structured fields');
    (run as unknown as { structuredResult: unknown }).structuredResult = {
      valid: true,
      value: { secret: 'removed result' },
    };
    run.activities = [
      {
        type: 'tool',
        label: 'submit removed result',
        status: 'completed',
        toolName: 'delegate_result',
        toolArguments: { secret: 'removed arguments' },
        toolResult: { secret: 'removed output' },
      },
      {
        type: 'tool',
        label: 'read source',
        status: 'completed',
        toolName: 'read',
        toolArguments: { path: 'src/a.ts' },
      },
    ];

    const serialized = serializeDelegateRunForPublic(run);
    expect(serialized.activities).toEqual([
      expect.objectContaining({ toolName: 'read', label: 'read source' }),
    ]);
    expect(JSON.stringify(serialized)).not.toContain('removed result');
    expect(JSON.stringify(serialized)).not.toContain('delegate_result');
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
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    expect(getDelegateLifecycle(run)?.reason).toBe(reason);
  });

  test('warns once at the soft threshold and leaves the local child running', async () => {
    const warning = vi.fn();
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockImplementation(
      async (run) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        processJsonLine(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'completed after warning' }],
            },
          }),
          run,
        );
        return { exitCode: 0, wasAborted: false, timedOut: false };
      },
    );

    const run = await runDelegate({
      cwd: '/tmp',
      task: 'continue after the warning',
      context: 'fresh',
      sessionPath: '/tmp/runtime-warning-test.jsonl',
      isolation: 'shared',
      warningAfterMs: 20,
      onRuntimeWarning: warning,
      maxConcurrency: 1,
      mode: 'single',
    });

    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(20);
    expect(run.state).toBe('success');
  });

  test('checks an overdue hosted delegate using its original start time without stopping it', async () => {
    const warning = vi.fn();
    const startedAt = Date.now() - 120_000;
    vi.spyOn(delegateChild, 'runHostedDelegateChild').mockImplementation(
      async (run) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        processJsonLine(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'restored result' }],
            },
          }),
          run,
        );
        return { exitCode: 0, wasAborted: false, timedOut: false };
      },
    );
    const run = await runDelegate({
      cwd: '/tmp',
      task: 'overdue hosted run',
      context: 'continuation',
      sessionPath: '/tmp/runtime-warning-restored.jsonl',
      isolation: 'shared',
      hosted: true,
      observeExisting: true,
      startedAt,
      warningAfterMs: 60_000,
      onRuntimeWarning: warning,
      maxConcurrency: 1,
      mode: 'single',
    });
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(120_000);
    expect(run.startedAt).toBe(startedAt);
    expect(run.state).toBe('success');
  });

  test('keeps explicit cancellation and does not warn after it', async () => {
    const controller = new AbortController();
    const warning = vi.fn();
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockImplementation(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { exitCode: 130, wasAborted: true, timedOut: false };
      },
    );

    const run = await runDelegate({
      cwd: '/tmp',
      task: 'cancel this run',
      context: 'fresh',
      sessionPath: '/tmp/runtime-warning-cancel-test.jsonl',
      isolation: 'shared',
      warningAfterMs: 20,
      onRuntimeWarning: warning,
      signal: controller.signal,
      maxConcurrency: 1,
      mode: 'single',
    });

    expect(warning).not.toHaveBeenCalled();
    expect(run.state).toBe('aborted');
  });

  test('marks successful-exit runs with truncated events as failures and publishes exact recovery evidence', async () => {
    const malformed = Buffer.concat([
      Buffer.from('private malformed event marker'),
      Buffer.from([0xff]),
      Buffer.alloc(70_000, 0x78),
    ]);
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockImplementation(
      async (run) => {
        processJsonLine(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'validated final result' }],
              usage: {
                input: 0,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 1,
              },
              timestamp: 1,
            },
          }),
          run,
        );
        recordDelegateEventOverflow(run, malformed.byteLength, malformed);
        return { exitCode: 0, wasAborted: false, timedOut: false };
      },
    );

    const run = await runDelegate({
      cwd: '/tmp',
      task: 'overflow classification',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-overflow-test.jsonl',
      isolation: 'shared',
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    expect(run.state).toBe('error');
    expect(run.exitCode).toBe(0);
    expect(getDelegateLifecycle(run)).toMatchObject({
      reason: 'event-overflow',
      eventOverflow: { eventCount: 1, capturedEvents: 1 },
    });

    const published: Array<{ bytes: Buffer; extension: string }> = [];
    const handoff = await buildOutputFileHandoff(
      [run],
      async (bytes, extension) => {
        const content = Buffer.from(bytes);
        published.push({ bytes: content, extension });
        return {
          path: `/tmp/pi/files/recovery${extension}`,
          size: content.byteLength,
        };
      },
    );
    expect(
      published.find(({ extension }) => extension === '.jsonl')?.bytes,
    ).toEqual(malformed);
    expect(handoff).toContain('/tmp/pi/files/recovery.jsonl');
    expect(handoff).toContain('Event overflow:');
    expect(handoff).not.toContain('private malformed event marker');

    const publicRun = serializeDelegateRunForPublic(run);
    expect(publicRun.lifecycle?.eventOverflow?.artifactFile?.path).toBe(
      '/tmp/pi/files/recovery.jsonl',
    );
    expect(JSON.stringify(publicRun)).not.toContain(
      'private malformed event marker',
    );
    const withoutFiles = cloneDelegateLifecycle(publicRun.lifecycle, {
      includeFile: false,
    });
    expect(
      Object.hasOwn(withoutFiles?.eventOverflow ?? {}, 'artifactFile'),
    ).toBe(false);
    const clonedRun = createRun('cross-owner clone');
    copyDelegateLifecycle(run, clonedRun, { includeFile: false });
    expect(
      Object.hasOwn(
        getDelegateLifecycle(clonedRun)?.eventOverflow ?? {},
        'artifactFile',
      ),
    ).toBe(false);
  });

  test.each([
    [
      'cancellation',
      { exitCode: 130, wasAborted: true, timedOut: false },
      'user-cancellation',
      'aborted',
    ],
    [
      'timeout',
      { exitCode: 124, wasAborted: false, timedOut: true },
      'timeout',
      'timed-out',
    ],
  ] as const)('keeps %s lifecycle precedence when event capture also overflows', async (_label, result, reason, state) => {
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockImplementation(
      async (run) => {
        recordDelegateEventOverflow(run, 1);
        return result;
      },
    );
    const run = await runDelegate({
      cwd: '/tmp',
      task: `overflow ${_label}`,
      context: 'fresh',
      sessionPath: `/tmp/lifecycle-overflow-${_label}.jsonl`,
      isolation: 'shared',
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    expect(run.state).toBe(state);
    expect(getDelegateLifecycle(run)).toMatchObject({
      reason,
      eventOverflow: { eventCount: 1 },
    });
  });

  test('counts every separator when enforcing the event artifact byte cap', async () => {
    const first = Buffer.alloc(3, 0x61);
    const second = Buffer.alloc(3, 0x62);
    const third = Buffer.alloc(
      BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES -
        first.length -
        second.length -
        1,
      0x63,
    );
    expect(first.length + second.length + third.length).toBe(
      BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES - 1,
    );
    const run = createRun('overflow artifact separators');
    recordDelegateEventOverflow(run, first.length, first);
    recordDelegateEventOverflow(run, second.length, second);
    recordDelegateEventOverflow(run, third.length, third);
    run.state = 'error';
    setDelegateLifecycleText(
      run,
      'event-overflow',
      'Truncated child events were not validated.',
    );

    let artifact = Buffer.alloc(0);
    await buildOutputFileHandoff([run], async (bytes) => {
      artifact = Buffer.from(bytes);
      return { path: '/tmp/pi/files/separated.jsonl', size: artifact.length };
    });

    expect(artifact).toEqual(Buffer.concat([first, Buffer.from('\n'), second]));
    expect(artifact.byteLength).toBeLessThanOrEqual(
      BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES,
    );
    expect(getDelegateLifecycle(run)?.eventOverflow).toMatchObject({
      capturedEvents: 2,
      capturedBytes: first.length + second.length,
      unavailableEvents: 1,
      unavailableReason: 'capture-limit',
      artifactFile: { path: '/tmp/pi/files/separated.jsonl' },
    });
  });

  test('reports overflow artifact publication failure without exposing payload bytes', async () => {
    const raw = Buffer.from('private publication marker');
    const run = createRun('overflow publication failure');
    recordDelegateEventOverflow(run, raw.byteLength, raw);
    run.state = 'error';
    setDelegateLifecycleText(
      run,
      'event-overflow',
      'Truncated child event was not validated.',
    );
    const handoff = await buildOutputFileHandoff([run], async () => {
      throw new Error('cache unavailable');
    });
    expect(getDelegateLifecycle(run)).toMatchObject({
      reason: 'event-overflow',
      eventOverflow: {
        capturedEvents: 1,
        artifactPublicationFailed: true,
      },
    });
    expect(
      getDelegateLifecycle(run)?.eventOverflow?.artifactFile,
    ).toBeUndefined();
    expect(handoff).toContain('Oversized event artifact publication failed.');
    expect(handoff).not.toContain('private publication marker');
  });

  test('retains a historical checkpoint when observing an old host timeout', async () => {
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockImplementation(
      async (run) => {
        run.checkpoint = {
          requestedAt: 1,
          state: 'acknowledged',
          acknowledgedAt: 2,
        };
        return { exitCode: 124, wasAborted: false, timedOut: true };
      },
    );

    const run = await runDelegate({
      cwd: '/tmp',
      task: 'checkpointed timeout',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-checkpoint-test.jsonl',
      isolation: 'shared',
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    expect(run.state).toBe('timed-out');
    expect(run.checkpoint?.state).toBe('acknowledged');
    expect(run.errorMessage).toContain('acknowledged a pre-timeout checkpoint');
    expect(makeDetails('single', [run]).runs[0]?.checkpoint).toMatchObject({
      state: 'acknowledged',
    });
  });

  test('forwards dashboard environment only to hosted children', async () => {
    vi.stubEnv('PI_DASHBOARD_SOCKET', '/tmp/dashboard.sock');
    vi.stubEnv('PI_DASHBOARD_STATE_DIR', '/tmp/dashboard-state');
    const foregroundEnvs: NodeJS.ProcessEnv[] = [];
    const hostedEnvs: NodeJS.ProcessEnv[] = [];
    vi.spyOn(delegateChild, 'spawnDelegateChild').mockImplementation(
      async (_run, options) => {
        foregroundEnvs.push(options.env);
        return { exitCode: 0, wasAborted: false, timedOut: false };
      },
    );
    await runDelegate({
      cwd: '/tmp',
      task: 'foreground environment',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-foreground-env.jsonl',
      isolation: 'shared',
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    vi.spyOn(delegateChild, 'runHostedDelegateChild').mockImplementation(
      async (_run, options) => {
        hostedEnvs.push(options.env);
        return { exitCode: 0, wasAborted: false, timedOut: false };
      },
    );
    await runDelegate({
      cwd: '/tmp',
      task: 'hosted environment',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-hosted-env.jsonl',
      isolation: 'shared',
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      hosted: true,
      ownerSessionId: 'parent-session',
      mode: 'single',
    });
    expect(foregroundEnvs[0]).not.toHaveProperty('PI_DASHBOARD_SOCKET');
    expect(foregroundEnvs[0]).not.toHaveProperty('PI_DASHBOARD_STATE_DIR');
    expect(hostedEnvs[0]).toMatchObject({
      PI_DASHBOARD_SOCKET: '/tmp/dashboard.sock',
      PI_DASHBOARD_STATE_DIR: '/tmp/dashboard-state',
    });
  });

  test('retains a hosted terminal error without classifying it as a spawn failure', async () => {
    const hostRestartError = 'HOST_RESTART_ERROR';
    vi.spyOn(delegateChild, 'runHostedDelegateChild').mockImplementation(
      async (run) => {
        run.stderr = 'raw host output '.repeat(10_000);
        return {
          exitCode: 1,
          wasAborted: false,
          timedOut: false,
          hostError: hostRestartError,
        };
      },
    );

    const run = await runDelegate({
      cwd: '/tmp',
      task: 'host restart diagnostic',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-hosted-error.jsonl',
      isolation: 'shared',
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      hosted: true,
      ownerSessionId: 'parent-session',
      mode: 'single',
    });

    expect(
      getDelegateLifecycle(run, { includeBoundedFallback: true }),
    ).toMatchObject({
      reason: 'child-nonzero-exit',
      diagnostic: expect.stringContaining(hostRestartError),
    });
  });

  test('classifies a retryable host transport failure without exposing raw output', async () => {
    vi.spyOn(delegateChild, 'runHostedDelegateChild').mockImplementation(
      async (run) => {
        run.stderr = 'raw host output '.repeat(10_000);
        return {
          exitCode: 1,
          wasAborted: false,
          timedOut: false,
          hostError: 'Background-jobs request timed out.',
          retryable: true,
        };
      },
    );
    const telemetry = vi.spyOn(harnessTelemetry, 'recordHarnessTelemetry');

    const run = await runDelegate({
      cwd: '/tmp',
      task: 'host restart diagnostic',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-hosted-error.jsonl',
      isolation: 'shared',
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      hosted: true,
      ownerSessionId: 'parent-session',
      mode: 'single',
    });

    expect(run.retryable).toBe(true);
    expect(
      getDelegateLifecycle(run, { includeBoundedFallback: true }),
    ).toMatchObject({
      reason: 'host-transport-error',
      continuationUsable: false,
      writableBranchRetained: false,
      readOnlySnapshotRetained: false,
      diagnostic: expect.stringContaining('Background-jobs request timed out.'),
    });
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'delegate.lifecycle',
        code: 'host-transport-error',
        outcome: 'failure',
      }),
    );
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain(
      'Background-jobs request timed out.',
    );
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain(
      'raw host output',
    );
    expect(JSON.stringify(getDelegateLifecycle(run))).toContain(
      'Background-jobs request timed out.',
    );
    expect(JSON.stringify(getDelegateLifecycle(run))).not.toContain(
      'raw host output',
    );
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
      warningAfterMs: 5_000,
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
      warningAfterMs: 5_000,
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
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    const unknown = await runDelegate({
      cwd: '/tmp',
      task: 'unknown',
      context: 'fresh',
      sessionPath: '/tmp/lifecycle-unknown.jsonl',
      isolation: 'shared',
      warningAfterMs: 5_000,
      maxConcurrency: 1,
      mode: 'single',
    });
    expect(getDelegateLifecycle(runner)?.reason).toBe('provider-runner-error');
    expect(getDelegateLifecycle(unknown)?.reason).toBe('unknown');
  });

  test('bounds a long diagnostic when output-file publication fails', async () => {
    const run = createRun('publication failure');
    run.state = 'error';
    setDelegateLifecycle(run, 'provider-runner-error', '🙂'.repeat(20_000));
    const handoff = await buildOutputFileHandoff([run], async () => {
      throw new Error('publication unavailable');
    });
    const diagnostic = getDelegateLifecycle(run)?.diagnostic ?? '';
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(
      LIFECYCLE_INLINE_DIAGNOSTIC_BYTES,
    );
    expect(diagnostic).toContain(LIFECYCLE_PUBLIC_FALLBACK_MARKER);
    expect(handoff).toContain(LIFECYCLE_PUBLIC_FALLBACK_MARKER);
  });

  test('writes an exact long Unicode diagnostic without inline clipping', async () => {
    const run = createRun('long failure');
    run.state = 'error';
    const exact = ['line one', '失敗🙂'.repeat(2_000), 'line three'].join('\n');
    setDelegateLifecycle(run, 'unknown', exact);
    let bytes = '';
    const handoff = await buildOutputFileHandoff([run], async (input) => {
      bytes = String(input);
      return {
        path: '/tmp/diagnostic.txt',
        size: Buffer.byteLength(bytes, 'utf8'),
      };
    });

    expect(bytes).toBe(getDelegateLifecycleDiagnostic(run));
    expect(handoff).toContain(
      `Failure file: /tmp/diagnostic.txt (${Buffer.byteLength(bytes, 'utf8')} bytes)`,
    );
    expect(handoff).not.toContain('失敗🙂'.repeat(100));
    expect(getDelegateLifecycle(run)).toMatchObject({
      reason: 'unknown',
      diagnosticFile: {
        path: '/tmp/diagnostic.txt',
        size: Buffer.byteLength(bytes, 'utf8'),
      },
    });
  });
});
