import type { BackgroundJob, BackgroundJobEvent } from '@pi-dashboard/protocol';
import type { ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundActivity,
  type LogState,
  mergeLogPage,
} from './background-activity';

vi.mock('../surface-stack', async () => {
  const actual =
    await vi.importActual<typeof import('../surface-stack')>(
      '../surface-stack',
    );
  function TestSurfaceStack({
    pages,
  }: {
    pages: readonly { title: string; children: ReactNode }[];
  }) {
    const page = pages.at(-1);
    return page ? (
      <div role="dialog" aria-label={page.title}>
        {page.children}
      </div>
    ) : null;
  }
  return { ...actual, SurfaceStack: TestSurfaceStack };
});

const job: BackgroundJob = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  sessionId: 'session-1',
  title: 'Dev server',
  command: 'bun run dev',
  cwd: '/workspace',
  status: 'done',
  events: true,
  createdAt: 1_000,
  settledAt: 62_000,
  exitCode: 0,
  stdout: { totalBytes: 12, droppedBytes: 0 },
  stderr: { totalBytes: 0, droppedBytes: 0 },
};

function textInTree(renderer: ReturnType<typeof create>): string {
  return JSON.stringify(renderer.toJSON());
}

describe('background activity', () => {
  it('keeps bounded log pages advancing and marks truncation/completion', () => {
    const initial: LogState = {
      events: [],
      truncated: false,
      locallyBounded: false,
      complete: false,
      error: 'temporary disconnect',
      revision: 0,
    };
    const page = (events: readonly BackgroundJobEvent[], extra = {}) => ({
      events,
      truncated: false,
      complete: false,
      ...extra,
    });
    const first = mergeLogPage(
      initial,
      page(
        Array.from({ length: 512 }, (_, offset) => ({
          offset,
          stream: 'stdout' as const,
          text: `line-${offset}\n`,
          truncated: false,
        })),
      ),
    );
    expect(first.events).toHaveLength(512);
    expect(first.error).toBeUndefined();
    const capped = mergeLogPage(
      first,
      page([
        { offset: 512, stream: 'stdout', text: 'latest\n', truncated: false },
      ]),
    );
    expect(capped.events).toHaveLength(512);
    expect(capped.events.at(-1)?.text).toBe('latest\n');
    expect(capped.revision).toBe(2);
    const complete = mergeLogPage(
      capped,
      page([], { truncated: true, complete: true }),
    );
    expect(complete.truncated).toBe(true);
    expect(complete.complete).toBe(true);
    expect(complete.revision).toBe(3);
    const duplicate = mergeLogPage(
      complete,
      page([
        { offset: 512, stream: 'stdout', text: 'latest\n', truncated: false },
      ]),
    );
    expect(duplicate.events).toHaveLength(512);
    expect(duplicate.revision).toBe(4);
  });

  it('renders metadata, opens a separate log surface, and cleans up', async () => {
    const unsubscribeLogs = vi.fn();
    const unsubscribeJobs = vi.fn();
    const backgroundJobEventsSubscribe = {
      subscribe: vi.fn(
        (_input: unknown, observer: { onData: (value: unknown) => void }) => {
          observer.onData({
            id: 'log-1',
            data: {
              sessionId: 'session-1',
              jobId: job.id,
              events: [
                {
                  offset: 0,
                  stream: 'stdout',
                  text: 'server ready\n',
                  truncated: false,
                },
              ],
              truncated: false,
              complete: true,
              nextOffset: 42,
            },
          });
          return { unsubscribe: unsubscribeLogs };
        },
      ),
    };
    const backgroundJobs = vi.fn(async () => ({
      sessionId: 'session-1',
      jobs: [job],
    }));
    const client = {
      backgroundJobs,
      getTrpcClient: vi.fn(async () => ({
        backgroundJobsSubscribe: {
          subscribe: vi.fn(
            (
              _input: unknown,
              observer: { onData: (value: unknown) => void },
            ) => {
              observer.onData({
                id: 'jobs-1',
                data: { sessionId: 'session-1', jobs: [job] },
              });
              return { unsubscribe: unsubscribeJobs };
            },
          ),
        },
        backgroundJobEventsSubscribe,
      })),
    } as never;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <BackgroundActivity client={client} sessionId="session-1" />,
      );
    });
    expect(textInTree(renderer)).toContain('Dev server');
    expect(textInTree(renderer)).not.toContain('bun run dev');
    expect(textInTree(renderer)).toContain('completed');
    expect(textInTree(renderer)).not.toContain('exit 0');
    const counters = renderer.root.findByProps({
      className: 'surface-stats activity-panel-counters',
    });
    const counterClasses = counters.children
      .filter((child) => typeof child !== 'string')
      .map((counter) => counter.props.className);
    expect(counterClasses).toEqual([
      undefined,
      undefined,
      undefined,
      'surface-done',
    ]);
    expect(backgroundJobs).not.toHaveBeenCalled();
    expect(backgroundJobEventsSubscribe.subscribe).not.toHaveBeenCalled();

    await act(async () => {
      const button = renderer.root
        .findAllByType('button')
        .find((candidate) =>
          String(candidate.props.className).includes('delegate-row-toggle'),
        );
      if (!button) throw new Error('background row button missing');
      button.props.onClick();
    });
    expect(textInTree(renderer)).toContain('bun run dev');
    expect(textInTree(renderer)).toContain('exit 0');
    expect(backgroundJobEventsSubscribe.subscribe).toHaveBeenCalledWith(
      { sessionId: 'session-1', jobId: job.id, offset: 0 },
      expect.any(Object),
    );
    expect(textInTree(renderer)).toContain('server ready');
    expect(textInTree(renderer)).toContain('Logs complete.');

    await act(async () => {
      renderer.update(
        <BackgroundActivity client={client} sessionId="other-session" />,
      );
    });
    expect(unsubscribeJobs).toHaveBeenCalled();
    act(() => renderer.unmount());
    expect(unsubscribeLogs).toHaveBeenCalled();
  });

  it('does not pretend historical jobs have logs when events were not recorded', async () => {
    const historical = { ...job, events: false };
    const logSubscribe = vi.fn();
    const client = {
      getTrpcClient: vi.fn(async () => ({
        backgroundJobsSubscribe: {
          subscribe: vi.fn(
            (
              _input: unknown,
              observer: { onData: (value: unknown) => void },
            ) => {
              observer.onData({
                id: 'jobs-1',
                data: { sessionId: 'session-1', jobs: [historical] },
              });
              return { unsubscribe: vi.fn() };
            },
          ),
        },
        backgroundJobEventsSubscribe: { subscribe: logSubscribe },
      })),
    } as never;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <BackgroundActivity client={client} sessionId="session-1" />,
      );
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((candidate) =>
          String(candidate.props.className).includes('delegate-row-toggle'),
        )
        ?.props.onClick();
    });
    expect(textInTree(renderer)).toContain('Logs not recorded for this job.');
    expect(logSubscribe).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('follows appended output at the bounded cap but respects scroll-away', async () => {
    let logObserver: { onData: (value: unknown) => void } | undefined;
    const logElement = { scrollHeight: 100, scrollTop: 0, clientHeight: 50 };
    const streamJob = job;
    const client = {
      getTrpcClient: vi.fn(async () => ({
        backgroundJobsSubscribe: {
          subscribe: vi.fn(
            (
              _input: unknown,
              observer: { onData: (value: unknown) => void },
            ) => {
              observer.onData({
                id: 'jobs-1',
                data: { sessionId: 'session-1', jobs: [streamJob] },
              });
              return { unsubscribe: vi.fn() };
            },
          ),
        },
        backgroundJobEventsSubscribe: {
          subscribe: vi.fn(
            (
              _input: unknown,
              observer: { onData: (value: unknown) => void },
            ) => {
              logObserver = observer;
              return { unsubscribe: vi.fn() };
            },
          ),
        },
      })),
    } as never;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <BackgroundActivity client={client} sessionId="session-1" />,
        {
          createNodeMock: (element) =>
            (element.props as { className?: unknown }).className ===
            'background-log'
              ? logElement
              : {},
        },
      );
    });
    await act(async () => {
      const row = renderer.root
        .findAllByType('button')
        .find((candidate) =>
          String(candidate.props.className).includes('delegate-row-toggle'),
        );
      if (!row) throw new Error('background row button missing');
      row.props.onClick();
    });
    const emit = (offset: number) =>
      logObserver?.onData({
        id: `log-${offset}`,
        data: {
          sessionId: 'session-1',
          jobId: streamJob.id,
          events: [
            { offset, stream: 'stdout', text: `${offset}\n`, truncated: false },
          ],
          truncated: false,
          complete: false,
          nextOffset: offset + 1,
        },
      });
    await act(async () => {
      for (let offset = 0; offset < 513; offset++) emit(offset);
    });
    expect(logElement.scrollTop).toBe(logElement.scrollHeight);
    logElement.scrollTop = 0;
    const log = renderer.root.findByProps({ className: 'background-log' });
    log.props.onScroll({ currentTarget: logElement });
    await act(async () => emit(513));
    expect(logElement.scrollTop).toBe(0);
    act(() => renderer.unmount());
  });
});
