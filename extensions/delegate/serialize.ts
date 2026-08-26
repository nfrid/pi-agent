import {
  deriveCompatibilityLineageId,
  deriveCompatibilityRunId,
} from './identity';
import {
  copyDelegateLifecycle,
  ensureDelegateLifecycle,
  getDelegateLifecycle,
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

export function serializeDelegateRunForPublic(run: DelegatedRun): DelegatedRun {
  const lifecycle = ensureDelegateLifecycle(run);
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
    ? { ...base, stderr: '', activities: publicActivities(run) }
    : {
        ...base,
        activities: publicActivities(run),
        ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
      };
  if (lifecycle) {
    publicRun.lifecycle = getDelegateLifecycle(run);
    copyDelegateLifecycle(run, publicRun);
  }
  return publicRun;
}
