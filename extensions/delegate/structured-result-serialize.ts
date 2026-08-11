import {
  copyDelegateLifecycle,
  ensureDelegateLifecycle,
  getDelegateLifecycle,
  hydrateDelegateLifecycle,
} from './lifecycle';
import { getDelegateResultSpec } from './structured-result-channel';
import type { DelegatedRun } from './types';

/**
 * Serialize a run for any public details/status/job surface. Structured result
 * evidence stays in the private run for settlement and artifact publication;
 * child messages, stderr, activity prose, and child-shaped lifecycle fields
 * never cross this boundary; lifecycle projections come only from harness state.
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
        activities: run.activities.map(
          ({
            latestText: _latestText,
            transcriptText: _transcriptText,
            ...activity
          }) => activity,
        ),
        ...(lifecycle || !run.errorMessage
          ? {}
          : { errorMessage: run.errorMessage }),
      }
    : lifecycle
      ? { ...base, stderr: '' }
      : {
          ...base,
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
