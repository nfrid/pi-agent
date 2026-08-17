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
import type { DelegatedActivity, DelegatedRun } from './types';

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
  return {
    ...base,
    ...(latestText !== undefined ? { latestText } : {}),
    ...(transcriptText !== undefined ? { transcriptText } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(toolArguments !== undefined ? { toolArguments } : {}),
    ...(toolResult !== undefined ? { toolResult } : {}),
    ...(toolArgumentsTruncated ? { toolArgumentsTruncated: true } : {}),
    ...(toolResultTruncated ? { toolResultTruncated: true } : {}),
  };
}

function publicActivities(run: DelegatedRun): DelegatedActivity[] {
  return run.activities
    .filter((activity) => activity.toolName !== 'delegate_result')
    .map(serializeActivityForPublic);
}

export function serializeDelegateRunForPublic(
  run: DelegatedRun,
  options: { includeArtifacts?: boolean } = {},
): DelegatedRun {
  const lifecycle = ensureDelegateLifecycle(run);
  const includeArtifacts = options.includeArtifacts !== false;
  const compatibilityLineageId =
    run.lineageId ??
    (run.continuation
      ? deriveCompatibilityLineageId(run.continuation)
      : undefined);
  const runtime = run as DelegatedRun & { structuredResult?: unknown };
  const {
    lifecycle: _childLifecycle,
    errorMessage: _errorMessage,
    structuredResult: _structuredResult,
    ...base
  } = {
    ...runtime,
    runId: run.runId ?? deriveCompatibilityRunId(run),
    ...(compatibilityLineageId ? { lineageId: compatibilityLineageId } : {}),
  };
  const publicRun: DelegatedRun = lifecycle
    ? {
        ...base,
        stderr: '',
        activities: publicActivities(run),
      }
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

export function serializeDelegateRunForStaleSession(
  run: DelegatedRun,
): DelegatedRun {
  const { artifact: _artifact, ...safeRun } = serializeDelegateRunForPublic(
    run,
    {
      includeArtifacts: false,
    },
  );
  const lifecycle = getDelegateLifecycle(run, {
    includeArtifact: false,
    includeBoundedFallback: true,
  });
  if (lifecycle) {
    safeRun.lifecycle = lifecycle;
    hydrateDelegateLifecycle(safeRun, lifecycle);
  }
  return safeRun;
}
