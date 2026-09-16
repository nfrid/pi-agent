import type {
  DashboardHttpClient,
  DashboardTrpcClient,
} from '@pi-dashboard/client';
import type { BackgroundJob, BackgroundJobEvent } from '@pi-dashboard/protocol';
import { useEffect, useRef, useState } from 'react';
import { SurfaceStack, SurfaceStats } from '../surface-stack';
import { ActivityCollapsibleSection } from './collapsible-list-section';
import { stateGlyph } from './state-glyphs';

const MAX_VISIBLE_EVENTS = 512;
const MAX_VISIBLE_TEXT = 256 * 1024;

export type LogState = {
  events: BackgroundJobEvent[];
  truncated: boolean;
  locallyBounded: boolean;
  complete: boolean;
  error?: string;
  /** Changes for every accepted page, even after the visible event cap is full. */
  revision: number;
};

function durationLabel(
  startedAt: number,
  settledAt: number | undefined,
  now: number,
) {
  const elapsed = Math.max(0, (settledAt ?? now) - startedAt);
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusLabel(job: BackgroundJob): string {
  switch (job.status) {
    case 'running':
      return 'running';
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
      return 'stopped';
  }
}

function outcomeLabel(job: BackgroundJob): string | undefined {
  if (job.status === 'running') return undefined;
  if (job.status === 'done')
    return `exit ${job.exitCode === undefined ? 0 : job.exitCode}`;
  if (job.status === 'failed') return job.error ?? 'command failed';
  return job.signal ? `stopped by ${job.signal}` : 'stopped';
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mergeLogPage(
  previous: LogState,
  page: {
    events: readonly BackgroundJobEvent[];
    truncated: boolean;
    complete: boolean;
  },
): LogState {
  const seen = new Set(
    previous.events.map((event) => `${event.stream}:${event.offset}`),
  );
  const events = [...previous.events];
  for (const event of page.events) {
    const key = `${event.stream}:${event.offset}`;
    if (!seen.has(key)) {
      seen.add(key);
      events.push(event);
    }
  }
  events.sort((left, right) => left.offset - right.offset);
  let locallyBounded = previous.locallyBounded;
  while (
    events.length > MAX_VISIBLE_EVENTS ||
    events.reduce((total, event) => total + event.text.length, 0) >
      MAX_VISIBLE_TEXT
  ) {
    events.shift();
    locallyBounded = true;
  }
  return {
    ...previous,
    events,
    truncated: previous.truncated || page.truncated,
    locallyBounded,
    complete: previous.complete || page.complete,
    error: undefined,
    revision: previous.revision + 1,
  };
}

function BackgroundLog({
  client,
  sessionId,
  job,
}: {
  client: DashboardHttpClient;
  sessionId: string;
  job: BackgroundJob;
}) {
  const [state, setState] = useState<LogState>(() => ({
    events: [],
    truncated: false,
    locallyBounded: false,
    complete: false,
    revision: 0,
  }));
  const logRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    let disposed = false;
    let subscription: { unsubscribe: () => void } | undefined;
    setState({
      events: [],
      truncated: false,
      locallyBounded: false,
      complete: false,
      revision: 0,
    });
    void client
      .getTrpcClient()
      .then((trpc: DashboardTrpcClient) => {
        if (disposed) return;
        subscription = trpc.backgroundJobEventsSubscribe.subscribe(
          { sessionId, jobId: job.id, offset: 0 },
          {
            onData: (page) => {
              if (disposed || !Array.isArray(page.data?.events)) return;
              setState((previous) => mergeLogPage(previous, page.data));
            },
            onError: (error) => {
              if (!disposed)
                setState((previous) => ({
                  ...previous,
                  error: displayError(error),
                }));
            },
          },
        );
      })
      .catch((error: unknown) => {
        if (!disposed)
          setState((previous) => ({ ...previous, error: displayError(error) }));
      });
    return () => {
      disposed = true;
      subscription?.unsubscribe();
    };
  }, [client, job.id, sessionId]);

  const eventCount = state.events.length;
  const logRevision = state.revision;
  useEffect(() => {
    const element = logRef.current;
    if (
      !element ||
      !atBottomRef.current ||
      eventCount === 0 ||
      logRevision === 0
    )
      return;
    element.scrollTop = element.scrollHeight;
  }, [eventCount, logRevision]);

  return (
    <div className="background-log-wrap">
      <div
        ref={logRef}
        className="background-log"
        role="log"
        aria-label={`${job.title} output`}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 8;
        }}
      >
        {state.events.length === 0 && !state.error && !state.complete && (
          <span className="background-log-status">Waiting for output…</span>
        )}
        {state.events.map((event) => (
          <span
            className={`background-log-line ${event.stream}`}
            key={`${event.stream}:${event.offset}`}
          >
            <b aria-hidden="true">[{event.stream}]</b> {event.text}
          </span>
        ))}
        {state.error && (
          <span className="background-log-status">
            Logs unavailable: {state.error}
          </span>
        )}
      </div>
      {(state.truncated || state.locallyBounded) && (
        <small className="background-log-note">
          Earlier output was truncated.
        </small>
      )}
      {state.complete && (
        <small className="background-log-note">Logs complete.</small>
      )}
    </div>
  );
}

function BackgroundRow({
  job,
  now,
  onOpen,
}: {
  job: BackgroundJob;
  now: number;
  onOpen: () => void;
}) {
  const state = statusLabel(job);
  const glyphState = job.status === 'killed' ? 'aborted' : job.status;
  const stateClass = `surface-${glyphState}`;
  return (
    <div className={`delegate-row ${stateClass}`}>
      <button
        type="button"
        className="delegate-row-toggle activity-panel-inset"
        aria-haspopup="dialog"
        onClick={onOpen}
      >
        <span className="surface-state" aria-hidden="true">
          {stateGlyph(glyphState)}
        </span>
        <span className="delegate-row-main">
          <span className="delegate-row-name">
            <strong>{job.title}</strong>
          </span>
        </span>
        <span className="delegate-row-meta">
          <span className={`delegate-row-status ${stateClass}`}>{state}</span>
          <span className="delegate-row-properties">
            <span>{durationLabel(job.createdAt, job.settledAt, now)}</span>
          </span>
        </span>
        <span className="delegate-row-chevron" aria-hidden="true">
          ›
        </span>
      </button>
    </div>
  );
}

function BackgroundInspector({
  client,
  sessionId,
  job,
}: {
  client: DashboardHttpClient;
  sessionId: string;
  job: BackgroundJob;
}) {
  return (
    <div className="background-inspector">
      <div className="background-inspector-details">
        <div>
          <span className="background-inspector-label">Command</span>
          <code>{job.command}</code>
        </div>
        {outcomeLabel(job) && (
          <div>
            <span className="background-inspector-label">Outcome</span>
            <span>{outcomeLabel(job)}</span>
          </div>
        )}
      </div>
      {job.events === true ? (
        <BackgroundLog client={client} sessionId={sessionId} job={job} />
      ) : (
        <p className="background-log-note background-log-not-recorded">
          Logs not recorded for this job.
        </p>
      )}
    </div>
  );
}

export function BackgroundActivity({
  client,
  sessionId,
}: {
  client: DashboardHttpClient;
  sessionId: string;
}) {
  const [jobs, setJobs] = useState<readonly BackgroundJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let disposed = false;
    let subscription: { unsubscribe: () => void } | undefined;
    setLoading(true);
    setError(undefined);
    setJobs([]);
    setSelectedJobId(undefined);
    void client
      .getTrpcClient()
      .then((trpc: DashboardTrpcClient) => {
        if (disposed) return;
        subscription = trpc.backgroundJobsSubscribe.subscribe(
          { sessionId },
          {
            onData: (response) => {
              if (!disposed && Array.isArray(response.data?.jobs)) {
                setJobs(response.data.jobs);
                setError(undefined);
                setLoading(false);
              }
            },
            onError: (cause) => {
              if (!disposed) {
                setError(displayError(cause));
                setLoading(false);
              }
            },
          },
        );
      })
      .catch((cause: unknown) => {
        if (!disposed) {
          setError(displayError(cause));
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
      subscription?.unsubscribe();
    };
  }, [client, sessionId]);

  useEffect(() => {
    if (!jobs.some((job) => job.status === 'running')) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [jobs]);

  if (error && jobs.length === 0)
    return (
      <section className="activity-panel-section" aria-label="Background">
        <p
          className="background-activity-status activity-panel-inset"
          role="status"
        >
          Background activity unavailable: {error}
        </p>
      </section>
    );
  if (!loading && jobs.length === 0) return null;

  const visibleJobs = expanded ? jobs : jobs.slice(0, 3);
  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  const stats = {
    running: jobs.filter((job) => job.status === 'running').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
    stopped: jobs.filter((job) => job.status === 'killed').length,
    done: jobs.filter((job) => job.status === 'done').length,
  };
  const inspectorPages = selectedJob
    ? [
        {
          id: `background-${selectedJob.id}`,
          title: `Background · ${selectedJob.title}`,
          eyebrow: null,
          backLabel: 'Back to background activity',
          headerSummary: (
            <span
              className={`background-inspector-header-meta surface-${selectedJob.status === 'killed' ? 'aborted' : selectedJob.status}`}
            >
              <span>{statusLabel(selectedJob)}</span>
              <span>
                {durationLabel(
                  selectedJob.createdAt,
                  selectedJob.settledAt,
                  now,
                )}
              </span>
            </span>
          ),
          children: (
            <BackgroundInspector
              client={client}
              sessionId={sessionId}
              job={selectedJob}
            />
          ),
        },
      ]
    : [];
  return (
    <>
      <ActivityCollapsibleSection
        title="Background"
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        totalCount={jobs.length}
        visibleCount={visibleJobs.length}
        summary={
          <SurfaceStats
            className="activity-panel-counters"
            showZero
            stats={[
              {
                label: 'running',
                value: stats.running,
                tone: 'surface-running',
              },
              { label: 'failed', value: stats.failed, tone: 'surface-failed' },
              {
                label: 'stopped',
                value: stats.stopped,
                tone: 'surface-aborted',
              },
              { label: 'done', value: stats.done, tone: 'surface-done' },
            ]}
          />
        }
      >
        {error && jobs.length > 0 && (
          <p
            className="background-activity-status activity-panel-inset"
            role="status"
          >
            Live background updates unavailable: {error}
          </p>
        )}
        {loading && jobs.length === 0 && (
          <p
            className="background-activity-status activity-panel-inset"
            role="status"
          >
            Loading background activity…
          </p>
        )}
        {visibleJobs.map((job) => (
          <BackgroundRow
            key={job.id}
            job={job}
            now={now}
            onOpen={() => setSelectedJobId(job.id)}
          />
        ))}
      </ActivityCollapsibleSection>
      <SurfaceStack
        pages={inspectorPages}
        kind="inspector"
        size="wide"
        className="surface-drawer work-surface-drawer background-inspector-drawer"
        onDepthChange={(depth) => {
          if (depth < 1) setSelectedJobId(undefined);
        }}
        onClose={() => setSelectedJobId(undefined)}
      />
    </>
  );
}
