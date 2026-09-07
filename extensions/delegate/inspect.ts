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
  const characters = Array.from(text);
  return characters.length > max
    ? `${characters.slice(0, max - 1).join('')}…`
    : text;
}

function elapsed(startedAt: number | undefined, endAt: number): string {
  if (startedAt === undefined) return 'unavailable';
  return `${Math.max(0, endAt - startedAt)}ms`;
}

function timestamp(at: number | undefined): string {
  if (at === undefined) return 'unavailable';
  return new Date(at).toISOString();
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
    const description = value('description');
    if (description) return `description=${description}`;
    const command =
      typeof record.command === 'string' ? record.command.trim() : '';
    if (!command) return undefined;
    // Inspect the original command, not its clipped prefix: redirection or an
    // inline payload may appear after the display limit. Prefer descriptions
    // for compound commands rather than attempting to parse shell scripts.
    const executable = command.match(/^[\w./-]+(?=\s|$)/)?.[0] ?? 'shell';
    const omitDetails =
      /["'`$<>;|&(){}\\\r\n]|apply_patch|git\s+apply|(?:^|\s)patch(?:\s|$)|\b(?:python|python3|node|ruby|perl|bash|sh)\s+-(?:c|e)\b/.test(
        command,
      );
    return omitDetails
      ? `command=${compact(executable, 80)} (details omitted)`
      : `command=${compact(command)}`;
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
  const name = compact(entry.name ?? 'unknown', 80);
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
  const transcriptError = [
    ...(target.status ? currentInvocationEntries(target.status) : []),
  ]
    .reverse()
    .find((entry) => entry.type === 'error')?.text;
  return transcriptError ? compact(transcriptError, 240) : undefined;
}

export function inspectDelegateTarget(
  target: InspectTarget,
  now = Date.now(),
): { text: string; details: InspectDetails } {
  const status = target.status;
  const states = [
    target.workflow?.state,
    target.job?.state,
    target.status?.state,
    target.state,
  ];
  const state =
    states.find(
      (candidate) => candidate !== undefined && isSettled(candidate),
    ) ?? target.state;
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
  lines.push(`last recorded activity (event start): ${timestamp(lastAt)}`);

  let activity: InspectDetails['activity'] = 'unavailable';
  if (settled) {
    activity = 'settled';
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
      activity = 'available';
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
    let clipped = '';
    for (const character of text) {
      const next = `${clipped}${character}`;
      if (
        Buffer.byteLength(`${next}${suffix}`, 'utf8') >
        DELEGATE_INSPECT_MAX_TEXT
      )
        break;
      clipped = next;
    }
    text = `${clipped}${suffix}`;
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
      activity,
    },
  };
}
