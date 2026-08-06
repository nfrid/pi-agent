import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { artifactProducer } from '../shared/artifacts';
import {
  copyDelegateLifecycle,
  getDelegateLifecycle,
  getDelegateLifecycleDiagnostic,
  isDelegateLifecycleDiagnosticPublicationFailed,
  LIFECYCLE_INLINE_DIAGNOSTIC_BYTES,
  markDelegateLifecycleDiagnosticPublicationFailed,
  setDelegateLifecycleDiagnosticArtifact,
} from './lifecycle';
import { buildParentHandoffResult } from './output';
import { throwIfAllRunsFailed } from './param-errors';
import {
  getDelegateResultSpec,
  getSettledDelegateResult,
  getStructuredArtifacts,
  type StructuredValidationResult,
  selectStructuredPath,
  serializeDelegateRunForPublic,
  setDelegateResultSpec,
  setStructuredArtifacts,
  settleDelegateResult,
} from './structured-result';
import {
  type DelegateDetails,
  type DelegatedRun,
  getExactFinalAssistantText,
} from './types';

export function makeDetails(
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
): DelegateDetails {
  return {
    mode,
    runs: runs.map((run) => serializeDelegateRunForPublic(run)),
  };
}

export const EXACT_OUTPUT_ARTIFACT_WARNING =
  'Exact output artifact unavailable; child session remains authoritative.';
export const STRUCTURED_RESULT_ARTIFACT_WARNING =
  'Structured result artifact unavailable; the validated result remains child-session-only.';

function structuredErrorWarning(run: DelegatedRun): string {
  const settlement = getSettledDelegateResult(run);
  return settlement?.errors.length
    ? `Structured result rejected: ${settlement.errors.join('; ')}`
    : 'Structured result rejected before artifact publication.';
}

function replaceWarning(
  run: DelegatedRun,
  oldWarning: string | undefined,
  nextWarning: string | undefined,
): void {
  const warnings = oldWarning
    ? (run.warnings ?? []).filter((warning) => warning !== oldWarning)
    : [...(run.warnings ?? [])];
  if (nextWarning && !warnings.includes(nextWarning))
    warnings.push(nextWarning);
  run.warnings = warnings;
}

async function publishLifecycleDiagnostic(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: DelegatedRun,
  put: typeof artifactProducer.put,
  assertCurrent?: () => void,
): Promise<boolean> {
  const lifecycle = getDelegateLifecycle(run);
  const diagnostic = getDelegateLifecycleDiagnostic(run);
  if (
    !lifecycle ||
    !diagnostic ||
    Buffer.byteLength(diagnostic, 'utf8') <=
      LIFECYCLE_INLINE_DIAGNOSTIC_BYTES ||
    lifecycle.diagnosticArtifact ||
    isDelegateLifecycleDiagnosticPublicationFailed(run)
  )
    return false;
  try {
    assertCurrent?.();
    const artifact = await put(pi, ctx, {
      bytes: diagnostic,
      producer: 'delegate',
      contentClass: 'delegate-output',
      mediaType: 'text/plain; charset=utf-8',
      creationSource: 'delegate.failure',
    });
    assertCurrent?.();
    setDelegateLifecycleDiagnosticArtifact(run, artifact);
    return true;
  } catch {
    // Keep the exact bounded capture inline when publication is unavailable;
    // silently clipping it would destroy the only actionable diagnostic.
    markDelegateLifecycleDiagnosticPublicationFailed(run);
    return true;
  }
}

async function publishStructuredArtifacts(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: DelegatedRun,
  put: typeof artifactProducer.put,
  assertCurrent?: () => void,
): Promise<boolean> {
  const spec = getDelegateResultSpec(run);
  if (!spec) return false;
  const settlement: StructuredValidationResult | undefined =
    getSettledDelegateResult(run) ?? settleDelegateResult(run, spec);
  if (!settlement?.valid) {
    replaceWarning(
      run,
      STRUCTURED_RESULT_ARTIFACT_WARNING,
      structuredErrorWarning(run),
    );
    return false;
  }
  let changed = false;
  if (!run.artifact) {
    const bytes = JSON.stringify(settlement.value);
    try {
      assertCurrent?.();
      run.artifact = await put(pi, ctx, {
        bytes,
        producer: 'delegate',
        contentClass: 'delegate-output',
        mediaType: 'application/json; charset=utf-8',
        creationSource: 'delegate.result',
      });
      assertCurrent?.();
      replaceWarning(run, STRUCTURED_RESULT_ARTIFACT_WARNING, undefined);
      changed = true;
    } catch {
      replaceWarning(run, undefined, STRUCTURED_RESULT_ARTIFACT_WARNING);
      return true;
    }
  }

  const sourceArtifact = run.artifact;
  if (!sourceArtifact) {
    replaceWarning(run, undefined, STRUCTURED_RESULT_ARTIFACT_WARNING);
    return true;
  }
  const existingViews = getStructuredArtifacts(run)?.views ?? {};
  const viewMetadata: Record<string, { handle: string; size: number }> = {
    ...existingViews,
  };
  for (const [name, path] of Object.entries(spec.views)) {
    if (viewMetadata[name]) continue;
    const selected = selectStructuredPath(settlement.value, path);
    if (!selected.present) {
      replaceWarning(
        run,
        STRUCTURED_RESULT_ARTIFACT_WARNING,
        `Structured result view "${name}" is unavailable because its path is absent.`,
      );
      changed = true;
      continue;
    }
    try {
      const viewBytes = JSON.stringify(selected.value);
      assertCurrent?.();
      const metadata = await put(
        pi,
        ctx,
        {
          bytes: viewBytes,
          producer: 'delegate',
          contentClass: 'delegate-output',
          mediaType: 'application/json; charset=utf-8',
          creationSource: 'delegate.view',
        },
        {
          assertCurrent,
          delegateView: { source: sourceArtifact, name, path },
        },
      );
      viewMetadata[name] = { handle: metadata.handle, size: metadata.size };
      assertCurrent?.();
      changed = true;
    } catch {
      replaceWarning(
        run,
        STRUCTURED_RESULT_ARTIFACT_WARNING,
        `Structured result view "${name}" is unavailable; the full artifact remains authoritative.`,
      );
      changed = true;
    }
  }
  setStructuredArtifacts(run, viewMetadata);
  return changed;
}

export async function buildArtifactBackedHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runs: DelegatedRun[],
  put = artifactProducer.put,
  assertCurrent?: () => void,
): Promise<string> {
  let result = buildParentHandoffResult(runs);
  const failedRuns = new Set<DelegatedRun>();
  for (let pass = 0; pass < runs.length + 1; pass++) {
    let changed = false;
    for (const run of runs) {
      changed ||= await publishLifecycleDiagnostic(
        pi,
        ctx,
        run,
        put,
        assertCurrent,
      );
      if (getDelegateResultSpec(run)) {
        const published = await publishStructuredArtifacts(
          pi,
          ctx,
          run,
          put,
          assertCurrent,
        );
        changed ||= published;
        continue;
      }
      if (
        run.artifact ||
        failedRuns.has(run) ||
        !result.omittedOriginalReports.has(run)
      )
        continue;
      const exact = getExactFinalAssistantText(run.messages);
      if (!exact) continue;
      try {
        assertCurrent?.();
        run.artifact = await put(pi, ctx, {
          bytes: exact,
          producer: 'delegate',
          contentClass: 'delegate-output',
          mediaType: 'text/plain; charset=utf-8',
          creationSource: 'delegate.result',
        });
        assertCurrent?.();
        run.warnings = (run.warnings ?? []).filter(
          (warning) => warning !== EXACT_OUTPUT_ARTIFACT_WARNING,
        );
        changed = true;
      } catch {
        run.warnings = [
          ...(run.warnings ?? []).filter(
            (warning) => warning !== EXACT_OUTPUT_ARTIFACT_WARNING,
          ),
          EXACT_OUTPUT_ARTIFACT_WARNING,
        ];
        failedRuns.add(run);
        changed = true;
      }
    }
    if (!changed) break;
    result = buildParentHandoffResult(runs, undefined, {
      inlineFallbackRuns: failedRuns,
    });
  }
  return result.text;
}

/** Publish only while the parent is still on the session that launched the job. */
export async function buildSessionBoundArtifactBackedHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  launchSessionId: string,
  runs: DelegatedRun[],
): Promise<string> {
  if (ctx.sessionManager.getSessionId() !== launchSessionId) {
    // A stale branch may still inspect the retained job. Never expose an
    // artifact handle owned by the launch session on that branch; retain the
    // original runs so a later inspection on the owner can publish/use it.
    const safeRuns = runs.map((run) => ({ ...run, artifact: undefined }));
    for (const [index, run] of safeRuns.entries()) {
      copyDelegateLifecycle(runs[index], run, { includeArtifact: false });
      const spec = getDelegateResultSpec(runs[index]);
      if (spec) {
        // Weak-map state intentionally does not cross the enumerable clone.
        // Reusing the spec keeps the stale branch artifact-only without
        // copying the structured result into its details.
        setDelegateResultSpec(run, spec);
      }
    }
    return buildArtifactBackedHandoff(pi, ctx, safeRuns, async () => {
      throw new Error('The delegate launch session is no longer current.');
    });
  }
  const assertLaunchSession = () => {
    if (ctx.sessionManager.getSessionId() !== launchSessionId)
      throw new Error('The delegate launch session is no longer current.');
  };
  const put = async (
    putPi: Parameters<typeof artifactProducer.put>[0],
    putCtx: Parameters<typeof artifactProducer.put>[1],
    input: Parameters<typeof artifactProducer.put>[2],
  ) => {
    assertLaunchSession();
    return artifactProducer.put(putPi, putCtx, input, {
      assertCurrent: assertLaunchSession,
    });
  };
  return buildArtifactBackedHandoff(pi, ctx, runs, put, assertLaunchSession);
}

export async function delegateToolResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
  launchSessionId = ctx.sessionManager.getSessionId(),
) {
  const handoff = await buildSessionBoundArtifactBackedHandoff(
    pi,
    ctx,
    launchSessionId,
    runs,
  );
  // A structured contract reports invalid child evidence as a non-success
  // envelope rather than throwing away all per-run diagnostics. Legacy prose
  // runs retain their historical all-failed throw behavior.
  if (
    !runs.some((run) => getDelegateResultSpec(run)) &&
    !runs.some((run) => getDelegateLifecycle(run))
  )
    throwIfAllRunsFailed(runs, handoff);
  const visibleRuns =
    ctx.sessionManager.getSessionId() === launchSessionId
      ? runs
      : runs.map((run) => ({
          ...serializeDelegateRunForPublic(run, { includeArtifacts: false }),
          artifact: undefined,
        }));
  return {
    content: [{ type: 'text' as const, text: handoff }],
    details: makeDetails(mode, visibleRuns),
  };
}
