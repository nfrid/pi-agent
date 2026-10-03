import {
  TELEMETRY_MAX_NOTE_LENGTH,
  type TelemetryIssue,
} from '@pi-agent/telemetry/contracts';
import { dashboardHttpClient } from '@pi-dashboard/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { reportDashboardQuirk } from '../telemetry';
import styles from './diagnostics.module.css';

const queryKey = ['telemetry-overview'] as const;
const time = (timestamp: number) => new Date(timestamp).toLocaleString();

export function DiagnosticsPage() {
  const [note, setNote] = useState('');
  const [showExpected, setShowExpected] = useState(false);
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey,
    queryFn: async () =>
      (await dashboardHttpClient.getTrpcClient()).telemetryOverview.query(),
    retry: false,
  });
  const report = useMutation({
    mutationFn: async (value: string) => {
      if (!(await reportDashboardQuirk(value)))
        throw new Error('Local report could not be saved.');
    },
    onSuccess: () => {
      setNote('');
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (note.trim()) report.mutate(note.trim());
  };
  const issues =
    overview.data?.issues.filter(
      (issue) => showExpected || issue.outcome !== 'expected',
    ) ?? [];
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Diagnostics</h1>
          <p>Local dashboard and harness failures and quirk reports.</p>
        </div>
        <button
          type="button"
          onClick={() => void overview.refetch()}
          disabled={overview.isFetching}
        >
          Refresh
        </button>
      </header>
      <p>
        No external uploads. Automatic records contain codes and metadata, not
        prompts, tool output or raw errors.
      </p>
      {overview.data && (
        <p>
          Retains up to {overview.data.maxEvents.toLocaleString()} events for{' '}
          {overview.data.retentionDays} days.{' '}
          {overview.data.eventCount.toLocaleString()} events currently retained.
          Shows the 100 most recently active issue groups.
        </p>
      )}
      <section className={styles.panel} aria-labelledby="quirk-heading">
        <h2 id="quirk-heading">Report a quirk</h2>
        <form onSubmit={submit} className={styles.form}>
          <label htmlFor="quirk-note">What went wrong?</label>
          <textarea
            id="quirk-note"
            value={note}
            maxLength={TELEMETRY_MAX_NOTE_LENGTH}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
            required
            aria-describedby="quirk-privacy"
          />
          <p id="quirk-privacy">
            Do not include secrets, prompts or tool output. The note and
            references to recent local telemetry will be saved. Common
            credentials, URLs and home paths are redacted. Notes are capped at
            1,000 UTF-8 bytes.
          </p>
          <button type="submit" disabled={!note.trim() || report.isPending}>
            Save local report
          </button>
          {report.isSuccess && <p role="status">Quirk recorded locally.</p>}
          {report.isError && (
            <p role="alert">
              Could not save the report. Check the local store or try again
              later.
            </p>
          )}
        </form>
      </section>
      <section aria-labelledby="issues-heading">
        <h2 id="issues-heading">Recorded issues</h2>
        <label className={styles.filter}>
          <input
            type="checkbox"
            checked={showExpected}
            onChange={(event) => setShowExpected(event.target.checked)}
          />
          Show expected outcomes, including cancellations and command rejections
        </label>
        {overview.isPending && <p role="status">Loading diagnostics…</p>}
        {(overview.isError || overview.data?.available === false) && (
          <p role="alert">
            Local telemetry is unavailable. Agent and dashboard operations are
            unaffected.
          </p>
        )}
        {overview.data?.available && issues.length === 0 && (
          <p>No issues recorded for this filter.</p>
        )}
        <div className={styles.issues}>
          {issues.map((issue) => (
            <Issue
              key={JSON.stringify([
                issue.source,
                issue.operation,
                issue.code,
                issue.outcome,
              ])}
              issue={issue}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function Issue({ issue }: { issue: TelemetryIssue }) {
  return (
    <article
      className={styles.panel}
      aria-label={`${issue.operation}: ${issue.code}`}
    >
      <h3>{issue.code}</h3>
      <p>
        {issue.source} · {issue.operation} · {issue.outcome}
      </p>
      <p>
        {issue.count.toLocaleString()} occurrences. First seen{' '}
        {time(issue.firstSeen)}. Last seen {time(issue.lastSeen)}.
      </p>
      {issue.outcome !== 'quirk' && (
        <p>
          {issue.failures.toLocaleString()} failures /{' '}
          {issue.attempts.toLocaleString()} recorded outcomes for this
          operation. Counts cover retained events, not a lifetime failure rate.
        </p>
      )}
      <details>
        <summary>Recent samples</summary>
        <ul className={styles.samples}>
          {issue.samples.map((sample) => (
            <li key={sample.id}>
              <p>
                {time(sample.timestamp)} · Version {sample.version}
              </p>
              {sample.errorName && <p>Error class: {sample.errorName}</p>}
              {sample.durationMs !== undefined && (
                <p>Duration: {sample.durationMs.toLocaleString()} ms</p>
              )}
              {sample.sessionId && (
                <p>
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: sample.sessionId }}
                  >
                    Open local session
                  </Link>
                </p>
              )}
              {sample.attemptId && <p>Attempt: {sample.attemptId}</p>}
              {sample.note && <p className={styles.note}>{sample.note}</p>}
              {sample.context && (
                <details>
                  <summary>Recent telemetry at report time</summary>
                  <ul>
                    {sample.context.map((event) => (
                      <li key={event.id}>
                        {time(event.timestamp)} · {event.source} ·{' '}
                        {event.operation} · {event.code} · {event.outcome}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
