import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { artifactProducer } from '../shared/artifacts';
import { buildParentHandoffResult } from './output';
import { throwIfAllRunsFailed } from './param-errors';
import {
  type DelegateDetails,
  type DelegatedRun,
  getExactFinalAssistantText,
} from './types';

export function makeDetails(
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
): DelegateDetails {
  return { mode, runs };
}

export const EXACT_OUTPUT_ARTIFACT_WARNING =
  'Exact output artifact unavailable; child session remains authoritative.';

export async function buildArtifactBackedHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runs: DelegatedRun[],
  put = artifactProducer.put,
): Promise<string> {
  let result = buildParentHandoffResult(runs);
  const failedRuns = new Set<DelegatedRun>();
  for (let pass = 0; pass < runs.length; pass++) {
    let changed = false;
    for (const run of runs) {
      if (
        run.artifact ||
        failedRuns.has(run) ||
        !result.omittedOriginalReports.has(run)
      )
        continue;
      const exact = getExactFinalAssistantText(run.messages);
      if (!exact) continue;
      try {
        run.artifact = await put(pi, ctx, {
          bytes: exact,
          producer: 'delegate',
          contentClass: 'delegate-output',
          mediaType: 'text/plain; charset=utf-8',
          creationSource: 'delegate.result',
        });
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
    return buildArtifactBackedHandoff(pi, ctx, safeRuns, async () => {
      throw new Error('The delegate launch session is no longer current.');
    });
  }
  const put = async (
    putPi: Parameters<typeof artifactProducer.put>[0],
    putCtx: Parameters<typeof artifactProducer.put>[1],
    input: Parameters<typeof artifactProducer.put>[2],
  ) => {
    const assertLaunchSession = () => {
      if (putCtx.sessionManager.getSessionId() !== launchSessionId)
        throw new Error('The delegate launch session is no longer current.');
    };
    assertLaunchSession();
    return artifactProducer.put(putPi, putCtx, input, {
      assertCurrent: assertLaunchSession,
    });
  };
  return buildArtifactBackedHandoff(pi, ctx, runs, put);
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
  throwIfAllRunsFailed(runs, handoff);
  const visibleRuns =
    ctx.sessionManager.getSessionId() === launchSessionId
      ? runs
      : runs.map((run) => ({ ...run, artifact: undefined }));
  return {
    content: [{ type: 'text' as const, text: handoff }],
    details: makeDetails(mode, visibleRuns),
  };
}
