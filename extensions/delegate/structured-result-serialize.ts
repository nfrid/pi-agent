import {
  deriveCompatibilityLineageId,
  deriveCompatibilityRunId,
} from './identity';
import {
  copyDelegateLifecycle,
  ensureDelegateLifecycle,
  getDelegateLifecycle,
  hydrateDelegateLifecycle,
} from './lifecycle';
import {
  getDelegateResultSpec,
  getSettledDelegateResult,
} from './structured-result-channel';
import { projectStructuredResult } from './structured-result-project';
import type {
  DelegatedActivity,
  DelegatedRun,
  DelegateStructuredResult,
} from './types';

/**
 * Format a bounded structured value as a small, schema-agnostic outline for
 * human-facing TUI surfaces. The value has already been validated; this is
 * presentation only and deliberately does not know any result contract.
 */
export function formatStructuredResult(
  value: unknown,
  maxChars = 12_000,
): string {
  const lines: string[] = [];
  const maxDepth = 8;
  const maxEntries = 32;
  const maxStringChars = 1_200;

  const primitive = (item: unknown): string => {
    if (typeof item === 'string') {
      const text = item.slice(0, maxStringChars);
      return item.length > maxStringChars ? `${text}…` : text;
    }
    if (item === null) return 'null';
    if (item === undefined) return 'undefined';
    if (typeof item === 'number' || typeof item === 'boolean')
      return String(item);
    return '[unavailable structured result]';
  };

  const humanize = (key: string): string => {
    const words = key
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_.-]+/g, ' ')
      .trim()
      .toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : '(unnamed)';
  };

  const render = (item: unknown, indent: string, depth: number): void => {
    if (depth >= maxDepth) {
      lines.push(`${indent}…`);
      return;
    }
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${indent}(empty)`);
        return;
      }
      item.slice(0, maxEntries).forEach((entry, index) => {
        const prefix = `${indent}${index + 1}.`;
        if (entry !== null && typeof entry === 'object') {
          lines.push(prefix);
          render(entry, `${indent}  `, depth + 1);
        } else lines.push(`${prefix} ${primitive(entry)}`);
      });
      if (item.length > maxEntries)
        lines.push(`${indent}… (${item.length - maxEntries} more items)`);
      return;
    }
    if (item !== null && typeof item === 'object') {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length === 0) {
        lines.push(`${indent}(empty)`);
        return;
      }
      entries.slice(0, maxEntries).forEach(([key, entry]) => {
        const label = humanize(key);
        if (entry !== null && typeof entry === 'object') {
          lines.push(`${indent}${label}:`);
          render(entry, `${indent}  `, depth + 1);
        } else lines.push(`${indent}${label}: ${primitive(entry)}`);
      });
      if (entries.length > maxEntries)
        lines.push(`${indent}… (${entries.length - maxEntries} more fields)`);
      return;
    }
    lines.push(`${indent}${primitive(item)}`);
  };

  render(value, '', 0);
  const output = lines.join('\n') || '[unavailable structured result]';
  if (output.length <= maxChars) return output;
  const marker = `\n… [truncated after ${maxChars.toLocaleString()} characters]`;
  if (maxChars <= marker.length) return output.slice(0, Math.max(0, maxChars));
  return `${output.slice(0, maxChars - marker.length)}${marker}`;
}

/**
 * Copy the bounded execution records captured on the private run into public
 * details. They are deliberately omitted from the live enumerable run so the
 * parent handoff cannot accidentally acquire child execution chatter, but the
 * human-facing details/status/job surfaces need them after persistence.
 *
 * The terminating structured channel is a separate parent handoff contract:
 * keep its activity marker, while the validated value is copied separately as
 * a human-facing structuredResult field.
 */
function serializeActivityForPublic(
  activity: DelegatedActivity,
): DelegatedActivity {
  const {
    latestText,
    transcriptText,
    toolName,
    toolArguments,
    toolResult,
    toolArgumentsTruncated,
    toolResultTruncated,
    ...base
  } = activity;
  const publicActivity: DelegatedActivity = {
    ...base,
    ...(latestText !== undefined ? { latestText } : {}),
    ...(transcriptText !== undefined ? { transcriptText } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
  };
  if (toolName !== 'delegate_result') {
    if (toolArguments !== undefined)
      publicActivity.toolArguments = toolArguments;
    if (toolResult !== undefined) publicActivity.toolResult = toolResult;
    if (toolArgumentsTruncated) publicActivity.toolArgumentsTruncated = true;
    if (toolResultTruncated) publicActivity.toolResultTruncated = true;
  }
  return publicActivity;
}

function publicActivities(run: DelegatedRun): DelegatedActivity[] {
  return run.activities.map(serializeActivityForPublic);
}

/**
 * The owner settlement is complete evidence for artifact publication, but it
 * is not a public details value. Public run records carry only the declared
 * parent projection, including an explicit omission when that projection is
 * empty or unavailable after persistence.
 */
export const PUBLIC_STRUCTURED_RESULT_CAPS = {
  aggregateBytes: 64 * 1024,
  maxValues: 64,
} as const;

function structuredValueBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return undefined;
  }
}

/** Bound a batch of already-public runs before it enters job/session details. */
export function boundPublicStructuredRuns(
  runs: readonly DelegatedRun[],
): DelegatedRun[] {
  let remainingBytes = PUBLIC_STRUCTURED_RESULT_CAPS.aggregateBytes;
  let values = 0;
  return runs.map((run) => {
    const structured = run.structuredResult;
    if (!structured?.valid || structured.value === undefined) return run;
    const bytes = structuredValueBytes(structured.value);
    if (
      bytes !== undefined &&
      values < PUBLIC_STRUCTURED_RESULT_CAPS.maxValues &&
      bytes <= remainingBytes
    ) {
      values++;
      remainingBytes -= bytes;
      return run;
    }
    const { value: _value, ...withoutValue } = structured;
    return {
      ...run,
      structuredResult: { ...withoutValue, valueOmitted: true },
    };
  });
}

function publicStructuredResult(
  run: DelegatedRun,
): DelegateStructuredResult | undefined {
  const captured = getSettledDelegateResult(run) ?? run.structuredResult;
  if (!captured) return undefined;
  if (!captured.valid)
    return {
      valid: false,
      errors: [...captured.errors],
    };

  const spec = getDelegateResultSpec(run);
  if (!spec)
    return {
      valid: true,
      ...(captured.value === undefined
        ? { valueOmitted: true }
        : { value: captured.value }),
      errors: [...captured.errors],
    };

  const projection =
    captured.value === undefined
      ? undefined
      : projectStructuredResult(spec, captured.value);
  return {
    valid: true,
    ...(projection?.value === undefined
      ? { valueOmitted: true }
      : { value: projection.value }),
    errors: [...captured.errors],
  };
}

/**
 * Serialize a run for any public details/status/job surface. Only the
 * parent-visible structured result projection is retained in its bounded
 * human-facing field; child messages, stderr, activity records for the terminating result, and
 * child-shaped lifecycle fields never cross this boundary; lifecycle
 * projections come only from harness state.
 */
export function serializeDelegateRunForPublic(
  run: DelegatedRun,
  options: { includeArtifacts?: boolean } = {},
): DelegatedRun {
  const structured = Boolean(getDelegateResultSpec(run));
  const lifecycle = ensureDelegateLifecycle(run);
  const includeArtifacts = options.includeArtifacts !== false;
  const compatibilityLineageId =
    run.lineageId ??
    (run.continuation
      ? deriveCompatibilityLineageId(run.continuation)
      : undefined);
  const {
    lifecycle: _childLifecycle,
    errorMessage: _errorMessage,
    structuredResult: _structuredResult,
    ...base
  } = {
    ...run,
    runId: run.runId ?? deriveCompatibilityRunId(run),
    ...(compatibilityLineageId ? { lineageId: compatibilityLineageId } : {}),
  };
  const projectedStructuredResult = publicStructuredResult(run);
  const publicRun: DelegatedRun = structured
    ? {
        ...base,
        messages: [],
        stderr: '',
        activities: publicActivities(run),
        ...(projectedStructuredResult
          ? { structuredResult: projectedStructuredResult }
          : {}),
        ...(lifecycle || !run.errorMessage
          ? {}
          : { errorMessage: run.errorMessage }),
      }
    : lifecycle
      ? {
          ...base,
          stderr: '',
          activities: publicActivities(run),
          ...(projectedStructuredResult
            ? { structuredResult: projectedStructuredResult }
            : {}),
        }
      : {
          ...base,
          activities: publicActivities(run),
          ...(projectedStructuredResult
            ? { structuredResult: projectedStructuredResult }
            : {}),
          ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
        };
  const projected = lifecycle
    ? getDelegateLifecycle(run, { includeArtifact: includeArtifacts })
    : undefined;
  if (projected) {
    publicRun.lifecycle = projected;
    copyDelegateLifecycle(run, publicRun, {
      includeArtifact: includeArtifacts,
    });
  }
  if (!includeArtifacts) delete publicRun.artifact;
  return publicRun;
}

/**
 * Project a run for a stale session. The exact lifecycle capture remains in
 * the owner run/weak-map; this clone carries only the bounded fallback and no
 * owner artifact handle.
 */
export function serializeDelegateRunForStaleSession(
  run: DelegatedRun,
): DelegatedRun {
  const { artifact: _artifact, ...safeRun } = serializeDelegateRunForPublic(
    run,
    { includeArtifacts: false },
  );
  const lifecycle = getDelegateLifecycle(run, {
    includeArtifact: false,
    includeBoundedFallback: true,
  });
  if (lifecycle) {
    safeRun.lifecycle = lifecycle;
    // Make the bounded projection authoritative for this clone. Copying the
    // source WeakMap record would otherwise restore the exact >2 KiB capture
    // before the stale handoff/details renderer gets to project it.
    hydrateDelegateLifecycle(safeRun, lifecycle);
  }
  return safeRun;
}
