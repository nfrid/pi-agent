import type { DelegateJobSnapshot } from './jobs';
import type { DelegateStatusSnapshot, DelegateTranscriptEntry } from './status';
import type { DelegateWorkflowAttemptSnapshot } from './workflow-coordinator';

export const DELEGATE_INSPECT_MAX_TEXT = 6_000;
const MAX_EVENTS = 10;
const MAX_FIELD = 180;

type InspectState =
  | DelegateStatusSnapshot['state']
  | DelegateWorkflowAttemptSnapshot['state'];

export interface InspectTarget {
  reference: string;
  state: InspectState;
  workflow?: DelegateWorkflowAttemptSnapshot;
  job?: DelegateJobSnapshot;
  status?: DelegateStatusSnapshot;
}

export interface InspectDetails {
  action: 'inspect';
  reference: string;
  state: InspectState;
  workflowIdentity?: string;
  jobId?: string;
  activity: 'available' | 'unavailable' | 'settled';
}

function compact(value: string, max = MAX_FIELD): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function elapsed(startedAt: number | undefined, endAt: number): string {
  if (startedAt === undefined) return 'unavailable';
  return `${Math.max(0, endAt - startedAt)}ms`;
}

function timestamp(at: number | undefined, now: number): string {
  if (at === undefined) return 'unavailable';
  return `${new Date(at).toISOString()} (${Math.max(0, now - at)}ms ago)`;
}

function argumentSummary(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return undefined;
  const record = args as Record<string, unknown>;
  const value = (key: string): string | undefined =>
    typeof record[key] === 'string'
      ? compact(record[key] as string)
      : undefined;
  if (name === 'bash' || name === 'shell') {
    const command = value('command');
    if (!command) return undefined;
    if (
      /apply_patch|git apply|(?:^|\s)patch(?:\s|$)|<<|(?:^|\s)(?:tee|cat)\s+/.test(
        command,
      )
    )
      return 'command=write operation (details omitted)';
    return `command=${command}`;
  }
  if (name === 'read' || name === 'write' || name === 'edit') {
    const path = value('path') ?? value('filePath');
    return path ? `path=${path}` : undefined;
  }
  if (name === 'grep' || name === 'search') {
    const query = value('pattern') ?? value('query');
    const path = value('path');
    return (
      [query ? `query=${query}` : undefined, path ? `path=${path}` : undefined]
        .filter(Boolean)
        .join(' · ') || undefined
    );
  }
  if (name === 'find' || name === 'glob') {
    const pattern = value('pattern') ?? value('glob');
    const path = value('path') ?? value('cwd');
    return (
      [
        pattern ? `pattern=${pattern}` : undefined,
        path ? `path=${path}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ') || undefined
    );
  }
  return undefined;
}

function eventLine(entry: DelegateTranscriptEntry): string | undefined {
  if (entry.type === 'assistant') {
    const text = entry.text?.trim();
    return text ? `assistant: ${compact(text)}` : undefined;
  }
  if (entry.type !== 'tool') return undefined;
  const name = compact(entry.name ?? entry.label, 80);
  const args = argumentSummary(entry.name ?? '', entry.arguments);
  const suffix = args ? ` — ${args}` : '';
  const truncation = entry.argumentsTruncated ? ' (args truncated)' : '';
  return `tool ${name} [${entry.status ?? 'unavailable'}]${suffix}${truncation}`;
}

function currentInvocationEntries(
  status: DelegateStatusSnapshot,
): DelegateTranscriptEntry[] {
  const entries = status.transcript ?? [];
  const run = status.runCount;
  return entries.filter(
    (entry) => run === undefined || run <= 1 || entry.run === run,
  );
}

function isSettled(state: InspectState): boolean {
  return !['queued', 'running', 'scheduled'].includes(state);
}

function metadataError(target: InspectTarget): string | undefined {
  const reason = target.workflow?.reason ?? target.job?.error;
  if (reason) return compact(reason, 240);
  const diagnostic = target.status?.lifecycle?.diagnostic;
  if (diagnostic) return compact(diagnostic, 240);
  const transcriptError = [...(target.status?.transcript ?? [])]
    .reverse()
    .find((entry) => entry.type === 'error')?.text;
  return transcriptError ? compact(transcriptError, 240) : undefined;
}

export function inspectDelegateTarget(
  target: InspectTarget,
  now = Date.now(),
): { text: string; details: InspectDetails } {
  const status = target.status;
  const state = target.state;
  const settled = isSettled(state);
  const startedAt =
    status?.startedAt ?? target.workflow?.startedAt ?? target.job?.startedAt;
  const finishedAt =
    status?.finishedAt ?? target.workflow?.settledAt ?? target.job?.settledAt;
  const endAt = settled ? (finishedAt ?? now) : now;
  const lines = [
    `Delegate ${target.reference}: ${state}`,
    `elapsed: ${elapsed(startedAt, endAt)}`,
  ];
  const lastAt =
    (status ? currentInvocationEntries(status).at(-1)?.at : undefined) ??
    status?.activity?.startedAt;
  if (lastAt !== undefined)
    lines.push(`last activity: ${timestamp(lastAt, now)}`);

  if (settled) {
    const error = metadataError(target);
    if (error) lines.push(`error: ${error}`);
    lines.push('activity: unavailable (settled; metadata only)');
  } else if (!status) {
    lines.push('activity: unavailable (live transcript not attached)');
  } else {
    const entries = currentInvocationEntries(status)
      .map(eventLine)
      .filter((line): line is string => line !== undefined);
    const omitted = (status.transcript?.length ?? 0) - entries.length;
    if (entries.length === 0) {
      lines.push(
        'activity: unavailable (no eligible assistant or tool activity; excluded or older activity omitted)',
      );
    } else {
      lines.push('recent activity:');
      for (const line of entries.slice(-MAX_EVENTS)) lines.push(`- ${line}`);
      if (
        entries.length > MAX_EVENTS ||
        status.transcriptTruncated ||
        omitted > 0
      )
        lines.push(
          '… omitted/truncated activity (thinking, results, or older events)',
        );
    }
  }

  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > DELEGATE_INSPECT_MAX_TEXT) {
    const suffix = '\n… inspect snapshot truncated';
    let end = text.length;
    while (
      end > 0 &&
      Buffer.byteLength(`${text.slice(0, end)}${suffix}`, 'utf8') >
        DELEGATE_INSPECT_MAX_TEXT
    )
      end--;
    text = `${text.slice(0, end)}${suffix}`;
  }
  return {
    text,
    details: {
      action: 'inspect',
      reference: target.reference,
      state,
      ...(target.workflow
        ? { workflowIdentity: target.workflow.identity }
        : {}),
      ...(target.job ? { jobId: target.job.id } : {}),
      activity: settled ? 'settled' : status ? 'available' : 'unavailable',
    },
  };
}
