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
        `Read-only snapshot: ${run.worktree.id} (checkout retired)`,
        `Cleanup: /delegate-worktrees ${run.worktree.id} drop`,
        `Continue: omit refresh to rehydrate this exact snapshot; use refresh wip or head for targeted verification. A refreshed continuation is not independent review; use a fresh delegate for that.`,
      );
    } else {
      const changeNode = run.workflowAttempt?.logicalId;
      lines.push(
        `Branch: ${run.worktree.branch} (${run.worktree.status === 'active' ? 'changes pending finalization' : run.worktree.hasWork ? `${run.worktree.changedPaths?.length ?? 0} changed path(s)` : 'no changes'}, from ${run.worktree.workBase.slice(0, 8)})`,
        `Worktree: ${run.worktree.worktreePath}`,
        ...(run.worktree.ownership === 'caller'
          ? ['Integration: manage this caller-owned branch in its checkout.']
          : changeNode
            ? [`Changes: delegate_changes review/merge node ${changeNode}`]
            : [`Changes: inspect with /delegate-worktrees ${run.worktree.id}`]),
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
  const evidence = extractReportField(originalBody, 'Evidence', 400);
  if (evidence) lines.push(`Evidence: ${evidence}`);
  const risks = extractReportField(originalBody, 'Risks', 240);
  if (risks) lines.push(`Risks: ${risks}`);
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
}

/** Builds a bounded envelope; exact final reports are represented by output files. */
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
  const mandatory = envelopeBlock(prepared, parallel);
  const overflow = Buffer.byteLength(mandatory, 'utf8') > totalCap;
  const fallbackCap = parallel ? caps.perTaskMaxBytes : caps.singleMaxBytes;
  let remaining = Math.max(0, totalCap - Buffer.byteLength(mandatory, 'utf8'));
  let emittedFallback = false;
  prepared = prepared.map((item, index) => {
    if (!item.inlineFallbackBody || remaining <= 0)
      return { ...item, body: '' };
    const prefix = `${emittedFallback ? '\n\n---\n\n' : '\n\n'}${
      parallel
        ? `### Task ${index + 1} inline fallback (output file unavailable)\n`
        : 'Inline fallback (output file unavailable)\n'
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
        ? `${parallel ? `### Task ${index + 1} inline fallback (output file unavailable)\n` : 'Inline fallback (output file unavailable)\n'}${item.body}`
        : '',
    )
    .filter(Boolean)
    .join('\n\n---\n\n');
  const overflowWarning = options.inlineFallbackRuns?.size
    ? 'Mandatory metadata exceeds the handoff size cap; inline fallbacks may not fit and the child session remains authoritative.'
    : 'Mandatory metadata exceeds the handoff size cap; exact reports remain in the child session.';
  const envelopes = envelopeBlock(prepared, parallel);
  const text = `${overflow ? `${overflowWarning}\n\n` : ''}${envelopes}${fallbackBlocks ? `${envelopes ? '\n\n' : ''}${fallbackBlocks}` : ''}`;
  return { text };
}

export function buildParentHandoff(
  runs: DelegatedRun[],
  caps: ParentHandoffCaps = PARENT_HANDOFF_CAPS,
): string {
  return buildParentHandoffResult(runs, caps).text;
}
