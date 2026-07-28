import {
  continuationRecoveryNote,
  type DelegatedRun,
  getExactFinalAssistantText,
  getRunState,
  isRunError,
} from './types';

/** Safety bounds for parent-visible delegated reports. */
export const PARENT_HANDOFF_CAPS = {
  singleMaxBytes: 12 * 1024,
  aggregateMaxBytes: 50 * 1024,
  perTaskMaxBytes: 8 * 1024,
} as const;

export interface ParentHandoffCaps {
  singleMaxBytes: number;
  aggregateMaxBytes: number;
  perTaskMaxBytes: number;
}

export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix =
    '\n\n[Output truncated for parent context; full output is preserved in tool details.]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (maxBytes <= suffixBytes) {
    let marker = suffix;
    while (marker && Buffer.byteLength(marker, 'utf8') > maxBytes)
      marker = marker.slice(0, -1);
    return marker;
  }
  const contentBudget = maxBytes - suffixBytes;
  let out = text.slice(0, contentBudget);
  while (Buffer.byteLength(out, 'utf8') > contentBudget) out = out.slice(0, -1);
  return out + suffix;
}

function clip(text: string, maxBytes: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(flat, 'utf8') <= maxBytes) return flat;
  const suffix = '…';
  const budget = maxBytes - Buffer.byteLength(suffix);
  let out = flat;
  while (out && Buffer.byteLength(out, 'utf8') > budget) out = out.slice(0, -1);
  return out + suffix;
}

const REPORT_LABELS = ['Outcome', 'Conclusion', 'Evidence', 'Risks', 'Blocked'];

function headingText(line: string, label: string): string | undefined {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replaceAll('**', '');
  const match = normalized.match(
    new RegExp(`^${label}\\s*(?::\\s*(.*))?$`, 'i'),
  );
  return match ? (match[1] ?? '') : undefined;
}

function startsSection(line: string): boolean {
  const trimmed = line.trim();
  if (/^#{1,6}\s/.test(trimmed)) return true;
  return REPORT_LABELS.some(
    (label) => headingText(trimmed, label) !== undefined,
  );
}

function extractReportField(
  report: string,
  label: string,
  maxBytes: number,
): string | undefined {
  const lines = report.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const heading = headingText(lines[index], label);
    if (heading === undefined) continue;
    const values = heading ? [heading] : [];
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next].trim();
      if (startsSection(line)) break;
      if (line) values.push(line.replace(/^[-*]\s+/, ''));
    }
    const value = values.join(', ').trim();
    return value ? clip(value, maxBytes) : undefined;
  }
  return undefined;
}

/** The question a child stopped on, when it ended its report with one. */
export function blockedQuestion(run: DelegatedRun): string | undefined {
  return extractReportField(
    getExactFinalAssistantText(run.messages),
    'Blocked',
    240,
  );
}

function runBody(run: DelegatedRun): {
  text: string;
  originalReport?: string;
} {
  const originalReport = getExactFinalAssistantText(run.messages);
  if (originalReport) return { text: originalReport, originalReport };
  return {
    text: run.errorMessage?.trim() || run.stderr.trim() || '(no output)',
  };
}

interface PreparedRun {
  run: DelegatedRun;
  envelope: string;
  originalBody: string;
  originalReport?: string;
  body: string;
}

function prepareRun(run: DelegatedRun): PreparedRun {
  const { text: originalBody, originalReport } = runBody(run);
  const lines = [
    `Status: ${getRunState(run)}`,
    `Outcome: ${extractReportField(originalBody, 'Outcome', 32) ?? '(not reported)'}`,
    `Conclusion: ${extractReportField(originalBody, 'Conclusion', 600) ?? '(not reported)'}`,
  ];
  if (run.continuation) lines.push(`Continuation: ${run.continuation}`);
  const blocked = extractReportField(originalBody, 'Blocked', 240);
  if (blocked)
    lines.push(
      `Blocked: ${blocked} — answer it and continue this subagent; its context is intact.`,
    );
  if (run.artifact)
    lines.push(
      `Artifact: ${run.artifact.handle} (${run.artifact.size} bytes, sha256 ${run.artifact.sha256})`,
    );
  if (run.worktree) {
    lines.push(
      `Branch: ${run.worktree.branch} (${run.worktree.status === 'active' ? 'changes pending finalization' : run.worktree.hasWork ? `${run.worktree.changedPaths?.length ?? 0} changed path(s)` : 'no changes'}, from ${run.worktree.workBase.slice(0, 8)})`,
      `Worktree: ${run.worktree.worktreePath}`,
      `Integrate with: delegate_branches review then merge, id ${run.worktree.id}`,
    );
    if (run.worktree.changedPaths?.length)
      lines.push(
        `Changed: ${run.worktree.changedPaths.slice(0, 20).join(', ')}${run.worktree.changedPaths.length > 20 ? ', …' : ''}`,
      );
  }
  if (isRunError(run)) {
    const failure =
      run.errorMessage?.trim() || run.stderr.trim() || originalBody;
    lines.push(`Failure: ${clip(failure, 120)}`);
  }
  const recoveryNote = continuationRecoveryNote(run);
  if (recoveryNote) lines.push(`Note: ${recoveryNote}`);
  const warnings = [run.routing?.warning, ...(run.warnings ?? [])].filter(
    (item): item is string => Boolean(item),
  );
  if (warnings.length)
    lines.push(`Warnings: ${clip(warnings.join('; '), 120)}`);
  const evidence = extractReportField(originalBody, 'Evidence', 400);
  if (evidence) lines.push(`Evidence: ${evidence}`);
  const risks = extractReportField(originalBody, 'Risks', 240);
  if (risks) lines.push(`Risks: ${risks}`);
  lines.push('Truncation: none');
  return {
    run,
    envelope: lines.join('\n'),
    originalBody,
    originalReport,
    body: '',
  };
}

function withTruncationMarker(item: PreparedRun): PreparedRun {
  const truncated = item.body !== item.originalBody;
  return {
    ...item,
    envelope: item.envelope.replace(
      /Truncation: (?:none|original report truncated)/,
      `Truncation: ${truncated ? 'original report truncated' : 'none'}`,
    ),
  };
}

function envelopeBlock(items: PreparedRun[], parallel: boolean): string {
  return items
    .map(
      (item, index) =>
        `${parallel ? `## Task ${index + 1}\n` : ''}${item.envelope}`,
    )
    .join('\n\n');
}

function allocateBodies(
  items: PreparedRun[],
  summary: string,
  totalCap: number,
  perBodyCap: number,
  parallel: boolean,
): PreparedRun[] {
  let remaining = Math.max(
    0,
    totalCap -
      Buffer.byteLength(
        `${summary}\n\n${envelopeBlock(items, parallel)}`,
        'utf8',
      ),
  );
  let emitted = false;
  return items.map((item, index) => {
    const prefix = `${emitted ? '\n\n---\n\n' : '\n\n'}${
      parallel ? `### Task ${index + 1} output\n` : 'Output\n'
    }`;
    const prefixBytes = Buffer.byteLength(prefix, 'utf8');
    if (!item.originalBody || remaining <= prefixBytes)
      return { ...item, body: '' };
    const available = Math.min(perBodyCap, remaining - prefixBytes);
    const body = truncateBytes(item.originalBody, available);
    emitted = true;
    remaining -= prefixBytes + Buffer.byteLength(body, 'utf8');
    return { ...item, body };
  });
}

export interface ParentHandoffResult {
  text: string;
  /** Runs whose exact final report was omitted or truncated from the handoff body. */
  truncatedOriginalReports: ReadonlySet<DelegatedRun>;
}

/** Builds a bounded handoff with every envelope allocated before report bodies. */
export function buildParentHandoffResult(
  runs: DelegatedRun[],
  caps: ParentHandoffCaps = PARENT_HANDOFF_CAPS,
): ParentHandoffResult {
  const parallel = runs.length > 1;
  const totalCap = parallel ? caps.aggregateMaxBytes : caps.singleMaxBytes;
  const perBodyCap = parallel ? caps.perTaskMaxBytes : caps.singleMaxBytes;
  const summary = `Delegated results: ${runs.length} run(s)`;
  let prepared = runs.map(prepareRun);

  // Markers add bytes to the mandatory envelope, so allocate once to discover
  // them and again against their final size.
  prepared = allocateBodies(
    prepared,
    summary,
    totalCap,
    perBodyCap,
    parallel,
  ).map(withTruncationMarker);
  prepared = allocateBodies(
    prepared,
    summary,
    totalCap,
    perBodyCap,
    parallel,
  ).map(withTruncationMarker);

  const mandatory = `${summary}\n\n${envelopeBlock(prepared, parallel)}`;
  const overflow = Buffer.byteLength(mandatory, 'utf8') > totalCap;
  const overflowWarning =
    'Mandatory metadata exceeds the handoff size cap; task bodies are omitted.';
  if (overflow) {
    prepared = prepared
      .map((item) => ({ ...item, body: '' }))
      .map(withTruncationMarker);
  }
  const envelopes = envelopeBlock(prepared, parallel);
  const bodies = prepared
    .map((item, index) =>
      item.body
        ? `${parallel ? `### Task ${index + 1} output\n` : 'Output\n'}${item.body}`
        : '',
    )
    .filter(Boolean)
    .join('\n\n---\n\n');
  const text = `${summary}${overflow ? `\n${overflowWarning}` : ''}\n\n${envelopes}${bodies ? `\n\n${bodies}` : ''}`;
  return {
    text,
    truncatedOriginalReports: new Set(
      prepared
        .filter(
          (item) =>
            item.originalReport !== undefined &&
            item.body !== item.originalReport,
        )
        .map((item) => item.run),
    ),
  };
}

export function buildParentHandoff(
  runs: DelegatedRun[],
  caps: ParentHandoffCaps = PARENT_HANDOFF_CAPS,
): string {
  return buildParentHandoffResult(runs, caps).text;
}
