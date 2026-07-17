import {
  type DelegatedRun,
  getFinalAssistantText,
  getRunState,
  isRunError,
} from './types';

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

function extractReportField(body: string, label: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const heading = new RegExp(`^(?:#{1,6}\\s*)?${label}\\s*:?\\s*(.*)$`, 'i');
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].trim().match(heading);
    if (!match) continue;
    const values = match[1] ? [match[1]] : [];
    for (
      let next = index + 1;
      next < lines.length && values.length < 5;
      next++
    ) {
      const line = lines[next].trim();
      if (!line || /^#{1,6}\s/.test(line)) break;
      values.push(line.replace(/^[-*]\s+/, ''));
    }
    const value = values.join(', ').trim();
    return value ? clip(value, 120) : undefined;
  }
  return undefined;
}

function runBody(run: DelegatedRun): string {
  const final = getFinalAssistantText(run.messages).trim();
  return (
    final || run.errorMessage?.trim() || run.stderr.trim() || '(no output)'
  );
}

interface PreparedRun {
  envelope: string;
  body: string;
  bodyTruncated: boolean;
}

function prepareRun(run: DelegatedRun, bodyCap: number): PreparedRun {
  const original = runBody(run);
  const body = truncateBytes(original, bodyCap);
  const bodyTruncated = body !== original;
  const lines = [`Status: ${getRunState(run)}`];
  if (run.continuation) lines.push(`Continuation: ${run.continuation}`);
  if (run.artifact)
    lines.push(
      `Artifact: ${run.artifact.handle} (${run.artifact.size} bytes, sha256 ${run.artifact.sha256})`,
    );
  if (run.readOnlyBoundary)
    lines.push(`Read-only boundary: ${run.readOnlyBoundary}`);
  if (run.isolation) {
    lines.push(
      `Isolation: ${run.isolation.id} (${run.isolation.backend}, dependencies=${run.isolation.dependencyMode}, status=${run.isolation.status})`,
    );
    if (run.isolation.patch)
      lines.push(
        `Patch: ${run.isolation.patch.changedPaths.length} path(s), ${run.isolation.patch.size} bytes, sha256 ${run.isolation.patch.sha256}${run.isolation.patch.handle ? `, artifact ${run.isolation.patch.handle}` : ''}`,
      );
    if (run.isolation.validation)
      lines.push(
        `Patch validation: ${run.isolation.validation.status}${run.isolation.validation.script ? ` (${run.isolation.validation.script})` : ''}`,
      );
    lines.push(
      `Patch actions: /delegate-patch ${run.isolation.id} show|diff|validate <script>|validate-command <argv...>|apply|discard`,
    );
  }
  if (isRunError(run)) {
    const failure = run.errorMessage?.trim() || run.stderr.trim() || original;
    lines.push(`Failure: ${clip(failure, 120)}`);
  }
  const warnings = [run.routing?.warning, ...(run.warnings ?? [])].filter(
    (item): item is string => Boolean(item),
  );
  if (warnings.length)
    lines.push(`Warnings: ${clip(warnings.join('; '), 120)}`);
  const validation = extractReportField(original, 'Validation');
  if (validation) lines.push(`Validation: ${validation}`);
  const changed = extractReportField(original, 'Changed files');
  if (changed) lines.push(`Changed files: ${changed}`);
  lines.push(
    `Truncation: ${bodyTruncated ? 'body truncated; full details preserved' : 'none'}`,
  );
  return { envelope: lines.join('\n'), body, bodyTruncated };
}

/** Builds parent-visible text while keeping every run's mandatory metadata ahead of all bodies. */
export function buildParentHandoff(
  runs: DelegatedRun[],
  caps: ParentHandoffCaps = PARENT_HANDOFF_CAPS,
): string {
  const parallel = runs.length > 1;
  const totalCap = parallel ? caps.aggregateMaxBytes : caps.singleMaxBytes;
  const perBodyCap = parallel ? caps.perTaskMaxBytes : caps.singleMaxBytes;
  let prepared = runs.map((run) => prepareRun(run, perBodyCap));
  const statusSummary = parallel
    ? `Delegated tasks: ${runs.filter((run) => !isRunError(run)).length}/${runs.length} succeeded`
    : 'Delegate handoff';
  let summary = statusSummary;

  const envelopeBlock = (items: PreparedRun[]) =>
    items
      .map(
        (item, index) =>
          `${parallel ? `## Task ${index + 1}\n` : ''}${item.envelope}`,
      )
      .join('\n\n');
  const mandatoryBytes = (items: PreparedRun[]) =>
    Buffer.byteLength(`${summary}\n\n${envelopeBlock(items)}`, 'utf8');
  const mandatoryOverflowWarning =
    'Mandatory envelope exceeds the production cap; opaque continuations and other mandatory metadata are preserved, and bodies are omitted.';
  if (mandatoryBytes(prepared) > totalCap)
    summary += `\n${mandatoryOverflowWarning}`;
  const allocateBodies = (items: PreparedRun[]) => {
    let remaining = Math.max(0, totalCap - mandatoryBytes(items));
    let emitted = false;
    return items.map((item, index) => {
      const prefix = `${emitted ? '\n\n---\n\n' : '\n\n'}${
        parallel ? `### Task ${index + 1} output\n` : 'Output\n'
      }`;
      const prefixBytes = Buffer.byteLength(prefix, 'utf8');
      if (remaining <= prefixBytes)
        return { ...item, body: '', bodyTruncated: true };
      const available = remaining - prefixBytes;
      const body = truncateBytes(item.body, available);
      emitted = true;
      remaining -= prefixBytes + Buffer.byteLength(body, 'utf8');
      return {
        ...item,
        body,
        bodyTruncated: item.bodyTruncated || body !== item.body,
      };
    });
  };
  const markTruncation = (items: PreparedRun[]) =>
    items.map((item) => ({
      ...item,
      envelope: item.envelope.replace(
        /Truncation: (?:none|body truncated; full details preserved)/,
        item.bodyTruncated
          ? 'Truncation: body truncated; full details preserved'
          : 'Truncation: none',
      ),
    }));

  // A second allocation accounts for the longer mandatory truncation markers.
  prepared = allocateBodies(prepared);
  prepared = allocateBodies(markTruncation(prepared));
  prepared = markTruncation(prepared);
  if (mandatoryBytes(prepared) > totalCap) {
    if (!summary.includes(mandatoryOverflowWarning))
      summary += `\n${mandatoryOverflowWarning}`;
    prepared = markTruncation(
      prepared.map((item) => ({
        ...item,
        body: '',
        bodyTruncated: true,
      })),
    );
  }
  const envelopes = envelopeBlock(prepared);
  const bodies = prepared
    .map((item, index) =>
      item.body
        ? `${parallel ? `### Task ${index + 1} output\n` : 'Output\n'}${item.body}`
        : '',
    )
    .filter(Boolean)
    .join('\n\n---\n\n');
  return `${summary}\n\n${envelopes}${bodies ? `\n\n${bodies}` : ''}`;
}
