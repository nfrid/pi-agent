import type {
  BackgroundJobEventsResponse,
  BackgroundJobsResponse,
} from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createDashboardRouter, type DashboardTrpcContext } from './trpc.js';

const job = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  sessionId: 'session-1',
  title: 'build',
  command: 'npm run build',
  cwd: '/tmp/project',
  events: true,
  status: 'running' as const,
  createdAt: 1,
  stdout: { totalBytes: 3, droppedBytes: 0 },
  stderr: { totalBytes: 0, droppedBytes: 0 },
};

function context(
  backgroundJobs: NonNullable<DashboardTrpcContext['backgroundJobs']>,
  backgroundJobEvents: NonNullable<DashboardTrpcContext['backgroundJobEvents']>,
  lastEventId?: string,
): DashboardTrpcContext {
  return {
    serverId: () => 'server-1',
    protocolVersion: 3,
    snapshot: () => ({
      serverId: 'server-1',
      revision: 0,
      cursor: 0,
      runtimes: [],
      sessions: [],
      unread: [],
    }),
    shellSnapshot: () => ({ snapshot: {}, cursor: 0 }),
    backgroundJobs,
    backgroundJobEvents,
    ...(lastEventId === undefined ? {} : { lastEventId }),
  };
}

describe('background activity tRPC contract', () => {
  it('keeps job metadata authoritative and logs on demand', async () => {
    const jobs = vi.fn(
      async (): Promise<BackgroundJobsResponse> => ({
        sessionId: 'session-1',
        jobs: [job],
      }),
    );
    const logs = vi.fn(
      async (
        sessionId: string,
        jobId: string,
        offset: number,
      ): Promise<BackgroundJobEventsResponse> => ({
        sessionId,
        jobId,
        events:
          offset === 0
            ? [{ offset: 0, stream: 'stdout', text: 'ok', truncated: false }]
            : [],
        truncated: false,
        complete: true,
        nextOffset: 42,
      }),
    );
    const ctx = context(jobs, logs);
    const caller = createDashboardRouter(ctx).createCaller(ctx);
    await expect(
      caller.backgroundJobs({ sessionId: 'session-1' }),
    ).resolves.toEqual({
      sessionId: 'session-1',
      jobs: [job],
    });
    await expect(
      caller.backgroundJobEvents({
        sessionId: 'session-1',
        jobId: job.id,
        offset: 0,
      }),
    ).resolves.toMatchObject({ nextOffset: 42, events: [{ text: 'ok' }] });
    expect(jobs).toHaveBeenCalledWith('session-1');
    expect(logs).toHaveBeenCalledWith('session-1', job.id, 0);
  });

  it('resumes a log subscription from its tracked offset', async () => {
    const jobs = vi.fn(
      async (): Promise<BackgroundJobsResponse> => ({
        sessionId: 'session-1',
        jobs: [],
      }),
    );
    const offsets: number[] = [];
    const logs = vi.fn(
      async (
        _sessionId,
        jobId,
        offset,
      ): Promise<BackgroundJobEventsResponse> => {
        offsets.push(offset);
        return {
          sessionId: 'session-1',
          jobId,
          events: [],
          truncated: false,
          complete: true,
          nextOffset: offset,
        };
      },
    );
    const ctx = context(jobs, logs, `background-log-${job.id}-17`);
    const caller = createDashboardRouter(ctx).createCaller(ctx);
    const stream = (await caller.backgroundJobEventsSubscribe({
      sessionId: 'session-1',
      jobId: job.id,
      offset: 0,
    })) as AsyncGenerator<
      readonly [string, BackgroundJobEventsResponse, symbol]
    >;
    const finalPage = await stream.next();
    expect(finalPage.done).toBe(false);
    expect(finalPage.value?.[1]).toMatchObject({
      events: [],
      complete: true,
      nextOffset: 17,
    });
    expect(offsets).toEqual([17]);
  });
});
