import { ensureDelegateLifecycle, getDelegateLifecycle } from './lifecycle';

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
  /** Retained for compatibility with callers that override the old shape. */
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
  const lines = [`Status: ${getRunState(run)}`];
  const workflowNode = run.workflowAttempt?.logicalId;
  if (run.continuation)
    lines.push(
      workflowNode
        ? `Continue: ${workflowNode}`
        : 'Continuation available in the retained child context.',
    );
  if (run.checkpoint) {
    const acknowledged = run.checkpoint.acknowledgedAt
      ? ` at ${new Date(run.checkpoint.acknowledgedAt).toISOString()}`
      : '';
    const review = isRunError(run)
      ? ' Retained partial state still requires review.'
      : '';
    lines.push(`Checkpoint: ${run.checkpoint.state}${acknowledged}.${review}`);
  }
  const blocked = extractReportField(originalBody, 'Blocked', 240);
  if (blocked)
    lines.push(
      `Blocked: ${blocked} — answer it and continue this subagent; its context is intact.`,
    );
  if (run.outputFile)
    lines.push(
      `Output file: ${run.outputFile.path} (${run.outputFile.size} bytes)`,
    );
  if (run.worktree) {
    if (run.worktree.snapshot) {
      lines.push(
        'Read-only snapshot retained (checkout retired).',
        ...(workflowNode
          ? [`Cleanup: delegate_changes drop node ${workflowNode}`]
          : []),
        'For a fresh perspective or current code state, start a fresh delegate instead.',
      );
    } else {
      const changeSummary =
        run.worktree.status === 'active'
          ? 'changes pending finalization'
          : run.worktree.hasWork
            ? `${run.worktree.changedPaths?.length ?? 0} changed path(s)`
            : 'no changes';
      lines.push(
        `Workspace result: ${changeSummary}.`,
        ...(run.worktree.ownership === 'caller'
          ? ['Changes: manage this caller-owned checkout directly.']
          : workflowNode
            ? [
                `Changes: delegate_changes review/merge/drop node ${workflowNode}`,
              ]
            : []),
      );
    }
    if (run.worktree.changedPaths?.length)
      lines.push(
        `Changed: ${run.worktree.changedPaths.slice(0, 20).join(', ')}${run.worktree.changedPaths.length > 20 ? ', …' : ''}`,
      );
  }
  if (isRunError(run)) {
    ensureDelegateLifecycle(run);
    const lifecycle = getDelegateLifecycle(run, {
      includeBoundedFallback: true,
    });
    if (lifecycle) {
      lines.push(`Lifecycle reason: ${lifecycle.reason}`);
      if (lifecycle.diagnosticFile)
        lines.push(
          `Failure file: ${lifecycle.diagnosticFile.path} (${lifecycle.diagnosticFile.size} bytes)`,
        );
      else if (lifecycle.diagnostic)
        lines.push(`Failure: ${lifecycle.diagnostic}`);
      else lines.push('Failure: exact lifecycle diagnostic file unavailable.');
      if (lifecycle.continuationUsable)
        lines.push('Continuation available for recovery.');
      if (lifecycle.writableBranchRetained)
        lines.push('Writable branch retained for review or integration.');
      if (lifecycle.readOnlySnapshotRetained)
        lines.push(
          'Read-only snapshot retained for inspection or continuation.',
        );
    } else {
      const failure =
        run.errorMessage?.trim() || run.stderr.trim() || originalBody;
      lines.push(`Failure: ${clip(failure, 120)}`);
    }
  }
  const recoveryNote = continuationRecoveryNote(run);
  if (recoveryNote) lines.push(`Note: ${recoveryNote}`);
  const warnings = [run.routing?.warning, ...(run.warnings ?? [])].filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  if (warnings.length)
    lines.push(`Warnings: ${clip(warnings.join('; '), 120)}`);
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
  requiresOutputFiles: readonly DelegatedRun[];
}

export const INLINE_REPORT_START = '--- begin untrusted delegate report ---';
export const INLINE_REPORT_END = '--- end untrusted delegate report ---';

function reportBlock(
  item: PreparedRun,
  parallel: boolean,
  index: number,
): string {
  if (!item.originalReport || item.run.outputFile || item.inlineFallbackBody)
    return '';
  const heading = parallel ? `### Task ${index + 1} report\n` : 'Report\n';
  return `${heading}${INLINE_REPORT_START}\n${item.originalReport}\n${INLINE_REPORT_END}`;
}

/** Build a lean parent message, inlining exact reports only when the whole message fits. */
export function buildParentHandoffResult(
  runs: DelegatedRun[],
  caps: ParentHandoffCaps = PARENT_HANDOFF_CAPS,
  options: { inlineFallbackRuns?: ReadonlySet<DelegatedRun> } = {},
): ParentHandoffResult {
  const parallel = runs.length > 1;
  const totalCap = parallel ? caps.aggregateMaxBytes : caps.singleMaxBytes;
  let prepared = runs.map((run) =>
    prepareRun(run, options.inlineFallbackRuns?.has(run) ?? false),
  );
  const envelopes = envelopeBlock(prepared, parallel);
  const perReportCap = parallel ? caps.perTaskMaxBytes : totalCap;
  const requiredOutputFiles: DelegatedRun[] = [];
  const inlineReports = prepared
    .map((item, index) => ({
      run: item.run,
      block: reportBlock(item, parallel, index),
    }))
    .filter(({ block }) => block.length > 0)
    .filter(({ run, block }) => {
      if (Buffer.byteLength(block, 'utf8') <= perReportCap) return true;
      requiredOutputFiles.push(run);
      return false;
    });
  const renderExact = () => {
    const reports = inlineReports.map(({ block }) => block).join('\n\n');
    return `${envelopes}${reports ? `${envelopes ? '\n\n' : ''}${reports}` : ''}`;
  };
  let exact = renderExact();
  while (
    Buffer.byteLength(exact, 'utf8') > totalCap &&
    inlineReports.length > 0
  ) {
    const removed = inlineReports.pop();
    if (removed) requiredOutputFiles.unshift(removed.run);
    exact = renderExact();
  }
  if (
    Buffer.byteLength(exact, 'utf8') <= totalCap &&
    !options.inlineFallbackRuns?.size
  )
    return { text: exact, requiresOutputFiles: requiredOutputFiles };
  const fallbackCap = parallel ? caps.perTaskMaxBytes : caps.singleMaxBytes;
  let remaining = Math.max(0, totalCap - Buffer.byteLength(envelopes, 'utf8'));
  let emittedFallback = false;
  prepared = prepared.map((item, index) => {
    if (!item.inlineFallbackBody || remaining <= 0)
      return { ...item, body: '' };
    const heading = parallel
      ? `### Task ${index + 1} inline fallback (output file unavailable)\n`
      : 'Inline fallback (output file unavailable)\n';
    const delimiter = emittedFallback ? '\n\n---\n\n' : envelopes ? '\n\n' : '';
    const framingBytes = Buffer.byteLength(
      `${delimiter}${heading}${INLINE_REPORT_START}\n\n${INLINE_REPORT_END}`,
      'utf8',
    );
    if (remaining <= framingBytes) return { ...item, body: '' };
    const available = Math.min(fallbackCap, remaining - framingBytes);
    const body = truncateBytes(item.inlineFallbackBody, available);
    remaining -= framingBytes + Buffer.byteLength(body, 'utf8');
    emittedFallback = true;
    return { ...item, body };
  });
  const fallbackBlocks = prepared
    .map((item, index) =>
      item.body
        ? `${parallel ? `### Task ${index + 1} inline fallback (output file unavailable)\n` : 'Inline fallback (output file unavailable)\n'}${INLINE_REPORT_START}\n${item.body}\n${INLINE_REPORT_END}`
        : '',
    )
    .filter(Boolean)
    .join('\n\n---\n\n');
  const metadataOverflow = Buffer.byteLength(envelopes, 'utf8') > totalCap;
  const warning = metadataOverflow
    ? 'Mandatory delegate metadata exceeds the parent handoff size cap.'
    : requiredOutputFiles.length > 0
      ? 'Delegate report exceeds the parent handoff size cap.'
      : undefined;
  const text = `${warning ? `${warning}\n\n` : ''}${envelopes}${fallbackBlocks ? `${envelopes ? '\n\n' : ''}${fallbackBlocks}` : ''}`;
  return { text, requiresOutputFiles: requiredOutputFiles };
}

export function buildParentHandoff(
  runs: DelegatedRun[],
  caps: ParentHandoffCaps = PARENT_HANDOFF_CAPS,
): string {
  const result = buildParentHandoffResult(runs, caps);
  return result.requiresOutputFiles.length > 0
    ? buildParentHandoffResult(runs, caps, {
        inlineFallbackRuns: new Set(result.requiresOutputFiles),
      }).text
    : result.text;
}
