import type {
  DelegateStatus,
  DelegateTranscriptEntry,
} from '../../../../extensions/delegate/contribution';
import { TranscriptEntry } from '../entities/transcript/entries';
import { StructuredResultSection } from '../entities/transcript/inspector';
import type { TranscriptModelItem } from '../transcript';
import { DashboardDialog } from './dashboard-dialog';

function text(value: string | undefined, fallback = ''): string {
  return value?.trim() || fallback;
}

function inspectorState(value: string): string {
  const state = value.toLowerCase();
  if (state === 'success' || state === 'done' || state === 'completed')
    return 'done';
  if (state === 'error' || state === 'failed' || state === 'timed-out')
    return 'failed';
  return state;
}

function inspectorStateClass(state: string): string {
  if (state === 'running') return 'surface-running';
  if (state === 'done') return 'surface-done';
  if (state === 'failed' || state === 'blocked') return 'surface-failed';
  if (state === 'aborted') return 'surface-aborted';
  return 'surface-queued';
}

function elapsed(
  start: number | undefined,
  finish: number | undefined,
  now: number,
): string | undefined {
  if (start === undefined) return undefined;
  const seconds = Math.max(0, Math.floor(((finish ?? now) - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function toolStatus(
  status: DelegateTranscriptEntry['status'],
): 'pending' | 'running' | 'success' | 'error' {
  if (status === 'error') return 'error';
  if (status === 'completed') return 'success';
  return status === 'running' ? 'running' : 'pending';
}

/**
 * Adapt the bounded public delegate stream to the main transcript entry
 * components. This deliberately consumes the live surface value as-is: it
 * never fetches a full session or reconstructs a transcript projection.
 */
export function delegateTranscriptItems(
  entries: readonly DelegateTranscriptEntry[],
): TranscriptModelItem[] {
  const occurrences = new Map<string, number>();
  return entries.map((entry) => {
    const baseKey = `${entry.run ?? 1}:${entry.id}`;
    const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
    occurrences.set(baseKey, occurrence);
    const key = occurrence === 1 ? baseKey : `${baseKey}:${occurrence}`;
    if (entry.type === 'task')
      return {
        key,
        entry: { kind: 'other' },
        raw: entry,
        text: text(entry.text),
        role: 'user',
      } as TranscriptModelItem;
    if (entry.type === 'thinking')
      return {
        key,
        entry: {
          kind: 'assistant',
          speaks: false,
          narration: 'thought',
        },
        raw: entry,
        thinking: entry.text ? [entry.text] : [],
        role: 'assistant',
      } as TranscriptModelItem;
    if (entry.type === 'tool') {
      const status = toolStatus(entry.status);
      const name = entry.name ?? entry.label;
      return {
        key,
        entry: {
          kind: 'tool',
          name,
          args: entry.arguments,
          status,
          ...(status === 'error' ? { isError: true } : {}),
        },
        raw: entry,
        tool: {
          kind: 'tool',
          key,
          toolCallId: key,
          name,
          ...(entry.arguments === undefined
            ? {}
            : { arguments: entry.arguments }),
          ...(entry.result === undefined ? {} : { result: entry.result }),
          status,
          ...(entry.text || entry.argumentsTruncated || entry.resultTruncated
            ? {
                data: {
                  ...(entry.text === undefined ? {} : { summary: entry.text }),
                  ...(entry.argumentsTruncated
                    ? { argumentsTruncated: true }
                    : {}),
                  ...(entry.resultTruncated ? { resultTruncated: true } : {}),
                },
              }
            : {}),
        },
      } as TranscriptModelItem;
    }
    if (entry.type === 'error')
      return {
        key,
        entry: { kind: 'other' },
        raw: entry,
        event: {
          kind: 'delegate-result',
          label: 'Delegate error',
          status: 'error',
          ...(entry.text ? { content: entry.text } : {}),
        },
      } as TranscriptModelItem;
    return {
      key,
      entry: { kind: 'assistant', speaks: true },
      raw: entry,
      text: text(entry.text),
      role: 'assistant',
    } as TranscriptModelItem;
  });
}

function delegateItemTimestamp(item: TranscriptModelItem): number | undefined {
  const raw = item.raw;
  return raw &&
    typeof raw === 'object' &&
    'at' in raw &&
    typeof raw.at === 'number'
    ? raw.at
    : undefined;
}

export function DelegateTranscript({
  entries,
  truncated = false,
}: {
  entries: readonly DelegateTranscriptEntry[];
  truncated?: boolean;
}) {
  const items = delegateTranscriptItems(entries);
  return (
    <section className="delegate-transcript" aria-label="Delegate transcript">
      {items.map((item) => (
        <TranscriptEntry
          item={item}
          key={item.key}
          timestampOverride={delegateItemTimestamp(item)}
        />
      ))}
      {truncated && (
        <p className="delegate-transcript-truncated">
          Earlier transcript entries were omitted from this live view.
        </p>
      )}
    </section>
  );
}

export function DelegateInspectorMetadata({
  row,
  now,
}: {
  row: DelegateStatus;
  now: number;
}) {
  const state = inspectorState(row.pauseState ?? row.state);
  const duration = elapsed(
    row.startedAt ?? row.createdAt,
    row.finishedAt,
    row.pausedAt ?? now,
  );
  const lifecycle = row.lifecycle;
  return (
    <fieldset
      className="delegate-inspector-metadata"
      aria-label="Delegate details"
    >
      <span className={inspectorStateClass(state)}>{state}</span>
      {duration && <span>{duration}</span>}
      {row.runCount && row.runCount > 1 && <span>{row.runCount} attempts</span>}
      {row.result && <span>result {row.result.status}</span>}
      {lifecycle && (
        <>
          <span>recovery {lifecycle.reason}</span>
          <span>
            continuation{' '}
            {lifecycle.continuationUsable ? 'ready' : 'unavailable'}
          </span>
          <span>
            {lifecycle.writableBranchRetained
              ? 'writable branch retained'
              : lifecycle.readOnlySnapshotRetained
                ? 'read-only snapshot retained'
                : 'no recovery checkout'}
          </span>
          {lifecycle.diagnostic && <span>diagnostic available</span>}
          {lifecycle.diagnosticArtifact && (
            <span>diagnostic artifact available</span>
          )}
        </>
      )}
    </fieldset>
  );
}

function artifactHandle(row: DelegateStatus): string | undefined {
  const artifact = row.lifecycle?.diagnosticArtifact;
  return artifact &&
    typeof artifact === 'object' &&
    typeof (artifact as { handle?: unknown }).handle === 'string'
    ? (artifact as { handle: string }).handle
    : undefined;
}

export function DelegateStructuredResultSection({
  row,
}: {
  row: DelegateStatus;
}) {
  if (!row.result) return null;
  return (
    <StructuredResultSection
      ariaLabel="Structured result"
      rawJsonLabel="structured result JSON"
      result={row.result}
      title="Structured result"
      valueOmittedMessage="Structured result value unavailable in this bounded live snapshot."
      valueUnavailableMessage="Structured result value is unavailable in this snapshot."
    />
  );
}

function DelegateInspectorDetails({
  row,
  now,
}: {
  row: DelegateStatus;
  now: number;
}) {
  const lifecycle = row.lifecycle;
  const runs = row.runs ?? [];
  const runKeyOccurrences = new Map<string, number>();
  const handle = artifactHandle(row);
  return (
    <details className="delegate-inspector-details">
      <summary>Run and recovery details</summary>
      <dl>
        {row.jobId && (
          <div>
            <dt>Job</dt>
            <dd>{row.jobId}</dd>
          </div>
        )}
        <div>
          <dt>Access</dt>
          <dd>{row.allowWrites ? 'read/write' : 'read-only'}</dd>
        </div>
        {row.context && (
          <div>
            <dt>Context</dt>
            <dd>{row.context}</dd>
          </div>
        )}
        {row.route && (
          <div>
            <dt>Route</dt>
            <dd>{row.route}</dd>
          </div>
        )}
      </dl>
      {runs.length > 0 && (
        <ol className="delegate-inspector-runs" aria-label="Run history">
          {runs.map((run, index) => {
            const duration = elapsed(
              run.startedAt,
              run.finishedAt,
              row.pausedAt ?? now,
            );
            const baseKey = `${run.state}:${run.startedAt ?? ''}:${run.finishedAt ?? ''}`;
            const occurrence = (runKeyOccurrences.get(baseKey) ?? 0) + 1;
            runKeyOccurrences.set(baseKey, occurrence);
            const key = occurrence === 1 ? baseKey : `${baseKey}:${occurrence}`;
            return (
              <li key={key}>
                <strong>Run {index + 1}</strong>
                <span
                  className={inspectorStateClass(inspectorState(run.state))}
                >
                  {inspectorState(run.state)}
                </span>
                {duration && <small>{duration}</small>}
              </li>
            );
          })}
        </ol>
      )}
      {lifecycle && (
        <div className="delegate-inspector-recovery">
          <strong>Recovery</strong>
          {lifecycle.diagnostic && <pre>{lifecycle.diagnostic}</pre>}
          {handle && (
            <p>
              Diagnostic artifact: <code>{handle}</code>
            </p>
          )}
        </div>
      )}
    </details>
  );
}

export function DelegateTranscriptInspector({
  row,
  now,
  isOpen,
  paused = false,
  onClose,
}: {
  row: DelegateStatus;
  now: number;
  isOpen: boolean;
  paused?: boolean;
  onClose: () => void;
}) {
  const entries = row.transcript ?? [];
  return (
    <DashboardDialog
      title="Delegate transcript"
      eyebrow="Delegate"
      headerSummary={text(row.name, 'Subagent')}
      headerContent={<DelegateInspectorMetadata row={row} now={now} />}
      className="surface-dialog delegate-transcript-dialog"
      isOpen={isOpen}
      paused={paused}
      onClose={onClose}
    >
      <div className="delegate-transcript-inspector-body">
        <DelegateStructuredResultSection row={row} />
        <DelegateInspectorDetails row={row} now={now} />
        {entries.length > 0 || row.transcriptTruncated ? (
          <DelegateTranscript
            entries={entries}
            truncated={row.transcriptTruncated === true}
          />
        ) : (
          <p className="delegate-transcript-empty">
            Waiting for the delegate to report transcript activity.
          </p>
        )}
      </div>
    </DashboardDialog>
  );
}
