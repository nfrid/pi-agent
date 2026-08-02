import {
  continuationRecoveryNote,
  type DelegatedRun,
  getExactFinalAssistantText,
  getRunState,
  isRunError,
} from './types';

/** Safety bounds for parent-visible delegated envelopes. */
export const PARENT_HANDOFF_CAPS = {
  singleMaxBytes: 12 * 1024,
  aggregateMaxBytes: 50 * 1024,
  /** Retained for compatibility; exact reports are no longer inline. */
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
    '\n\n[Output truncated for parent context; the full report remains in the child session.]';
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
  inlineFallbackBody?: string;
  body?: string;
}

function prepareRun(run: DelegatedRun, inlineFallback: boolean): PreparedRun {
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
    if (run.worktree.snapshot) {
      lines.push(
        `Read-only snapshot: ${run.worktree.id} (checkout retired)`,
        `Cleanup: delegate_branches drop ${run.worktree.id}`,
        `Continue: omit refresh to rehydrate this exact snapshot; use refresh wip or head for targeted verification. A refreshed continuation is not independent review; use a fresh delegate for that.`,
      );
    } else {
      lines.push(
        `Branch: ${run.worktree.branch} (${run.worktree.status === 'active' ? 'changes pending finalization' : run.worktree.hasWork ? `${run.worktree.changedPaths?.length ?? 0} changed path(s)` : 'no changes'}, from ${run.worktree.workBase.slice(0, 8)})`,
        `Worktree: ${run.worktree.worktreePath}`,
        `Integrate with: delegate_branches review then merge, id ${run.worktree.id}`,
      );
    }
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
    ...(inlineFallback && originalReport
      ? { inlineFallbackBody: originalBody }
      : {}),
  };
}

function withTruncationMarker(item: PreparedRun): PreparedRun {
  return {
    ...item,
    envelope: item.envelope.replace(
      /Truncation: none/,
      `Truncation: ${item.originalReport ? 'original report omitted' : 'none'}`,
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

export interface ParentHandoffResult {
  text: string;
  /** Runs whose exact final report is omitted from the parent-visible envelope. */
  omittedOriginalReports: ReadonlySet<DelegatedRun>;
  /** @deprecated Use omittedOriginalReports; retained for continuation compatibility. */
  truncatedOriginalReports: ReadonlySet<DelegatedRun>;
}

/** Builds a bounded envelope; exact final reports are never copied inline unless artifact publication failed. */
export function buildParentHandoffResult(
  runs: DelegatedRun[],
  caps: ParentHandoffCaps = PARENT_HANDOFF_CAPS,
  options: { inlineFallbackRuns?: ReadonlySet<DelegatedRun> } = {},
): ParentHandoffResult {
  const parallel = runs.length > 1;
  const totalCap = parallel ? caps.aggregateMaxBytes : caps.singleMaxBytes;
  const summary = `Delegated results: ${runs.length} run(s)`;
  let prepared = runs
    .map((run) =>
      prepareRun(run, options.inlineFallbackRuns?.has(run) ?? false),
    )
    .map(withTruncationMarker);
  const mandatory = `${summary}\n\n${envelopeBlock(prepared, parallel)}`;
  const overflow = Buffer.byteLength(mandatory, 'utf8') > totalCap;
  const fallbackCap = parallel ? caps.perTaskMaxBytes : caps.singleMaxBytes;
  let remaining = Math.max(0, totalCap - Buffer.byteLength(mandatory, 'utf8'));
  let emittedFallback = false;
  prepared = prepared.map((item, index) => {
    if (!item.inlineFallbackBody || remaining <= 0)
      return { ...item, body: '' };
    const prefix = `${emittedFallback ? '\n\n---\n\n' : '\n\n'}${
      parallel
        ? `### Task ${index + 1} inline fallback (artifact unavailable)\n`
        : 'Inline fallback (artifact unavailable)\n'
    }`;
    const prefixBytes = Buffer.byteLength(prefix, 'utf8');
    if (remaining <= prefixBytes) return { ...item, body: '' };
    const available = Math.min(fallbackCap, remaining - prefixBytes);
    const body = truncateBytes(item.inlineFallbackBody, available);
    emittedFallback = true;
    remaining -= prefixBytes + Buffer.byteLength(body, 'utf8');
    return { ...item, body };
  });
  const fallbackBlocks = prepared
    .map((item, index) =>
      item.body
        ? `${parallel ? `### Task ${index + 1} inline fallback (artifact unavailable)\n` : 'Inline fallback (artifact unavailable)\n'}${item.body}`
        : '',
    )
    .filter(Boolean)
    .join('\n\n---\n\n');
  const overflowWarning = options.inlineFallbackRuns?.size
    ? 'Mandatory metadata exceeds the handoff size cap; inline fallbacks may not fit and the child session remains authoritative.'
    : 'Mandatory metadata exceeds the handoff size cap; exact reports remain artifact-only.';
  const envelopes = envelopeBlock(prepared, parallel);
  const text = `${summary}${overflow ? `\n${overflowWarning}` : ''}\n\n${envelopes}${fallbackBlocks ? `\n\n${fallbackBlocks}` : ''}`;
  const omittedOriginalReports = new Set(
    prepared
      .filter((item) => item.originalReport !== undefined)
      .map((item) => item.run),
  );
  return {
    text,
    omittedOriginalReports,
    truncatedOriginalReports: omittedOriginalReports,
  };
}

export function buildParentHandoff(
  runs: DelegatedRun[],
  caps: ParentHandoffCaps = PARENT_HANDOFF_CAPS,
): string {
  return buildParentHandoffResult(runs, caps).text;
}
