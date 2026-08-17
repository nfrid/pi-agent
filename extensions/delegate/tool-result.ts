import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { artifactProducer } from '../shared/artifacts';
import {
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
  serializeDelegateRunForPublic,
  serializeDelegateRunForStaleSession,
} from './serialize';
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

export async function buildSessionBoundArtifactBackedHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  launchSessionId: string,
  runs: DelegatedRun[],
  launchBranchId?: string,
  isLaunchBranchActive?: () => boolean,
): Promise<string> {
  const ownerBranchActive =
    launchBranchId === undefined ? true : (isLaunchBranchActive?.() ?? false);
  if (
    ctx.sessionManager.getSessionId() !== launchSessionId ||
    !ownerBranchActive
  ) {
    // A stale branch may still inspect the retained job. Never expose an
    // artifact handle owned by the launch session on that branch; retain the
    // original runs so a later inspection on the owner can publish/use it.
    const safeRuns = runs.map((run) => {
      return serializeDelegateRunForStaleSession(run);
    });
    return buildArtifactBackedHandoff(pi, ctx, safeRuns, async () => {
      throw new Error('The delegate launch session is no longer current.');
    });
  }
  const assertLaunchSession = () => {
    if (
      ctx.sessionManager.getSessionId() !== launchSessionId ||
      (launchBranchId !== undefined && !isLaunchBranchActive?.())
    )
      throw new Error('The delegate launch branch is no longer current.');
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
  launchBranchId?: string,
  isLaunchBranchActive?: () => boolean,
) {
  const handoff = await buildSessionBoundArtifactBackedHandoff(
    pi,
    ctx,
    launchSessionId,
    runs,
    launchBranchId,
    isLaunchBranchActive,
  );
  if (!runs.some((run) => getDelegateLifecycle(run)))
    throwIfAllRunsFailed(runs, handoff);
  const exactOwnerVisible =
    ctx.sessionManager.getSessionId() === launchSessionId &&
    (launchBranchId === undefined || isLaunchBranchActive?.() === true);
  const visibleRuns = exactOwnerVisible
    ? runs
    : runs.map((run) => {
        const safe = serializeDelegateRunForStaleSession(run);
        return safe;
      });
  return {
    content: [{ type: 'text' as const, text: handoff }],
    details: makeDetails(mode, visibleRuns),
  };
}
