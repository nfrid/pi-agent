import {
  copyDelegateLifecycle,
  ensureDelegateLifecycle,
  getDelegateLifecycle,
  hydrateDelegateLifecycle,
} from './lifecycle';
import { getDelegateResultSpec } from './structured-result-channel';
import type { DelegatedActivity, DelegatedRun } from './types';

/**
 * Copy the bounded execution records captured on the private run into public
 * details. They are deliberately omitted from the live enumerable run so the
 * parent handoff cannot accidentally acquire child execution chatter, but the
 * human-facing details/status/job surfaces need them after persistence.
 *
 * The terminating structured channel is a separate artifact/projection
 * contract: keep its activity marker, but never copy its arguments or result.
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
 * Serialize a run for any public details/status/job surface. Structured result
 * evidence stays in the private run for settlement and artifact publication;
 * child messages, stderr, activity records for the terminating result, and
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
  const {
    lifecycle: _childLifecycle,
    errorMessage: _errorMessage,
    ...base
  } = run;
  const publicRun: DelegatedRun = structured
    ? {
        ...base,
        messages: [],
        stderr: '',
        activities: publicActivities(run),
        ...(lifecycle || !run.errorMessage
          ? {}
          : { errorMessage: run.errorMessage }),
      }
    : lifecycle
      ? { ...base, stderr: '', activities: publicActivities(run) }
      : {
          ...base,
          activities: publicActivities(run),
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
