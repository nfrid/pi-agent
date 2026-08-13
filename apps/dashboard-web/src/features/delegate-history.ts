import type {
  DelegateHistoryDetails,
  DelegateHistoryGroup,
  DelegateHistoryInvocation,
  DelegateHistoryResponse,
} from '@pi-dashboard/protocol';
import type {
  DelegateResult,
  DelegateStatus,
  DelegateTranscriptEntry,
} from '../../../../extensions/delegate/contribution';
import type {
  DelegatedActivity,
  DelegateLifecycleReason,
} from '../../../../extensions/delegate/types';

/** Extra inspection facts which are only present on the persisted adapter. */
export type DelegateInspectionStatus = DelegateStatus & {
  historical?: boolean;
  historyIncomplete?: boolean;
  warnings?: readonly string[];
};

export interface DelegateCompositeRun {
  id: string;
  label: string;
  row: DelegateInspectionStatus;
}

export type DelegateCompositeSection = 'active' | 'recent' | 'history';

export interface DelegateCompositeGroup {
  lineageId: string;
  row: DelegateInspectionStatus;
  runs: readonly DelegateCompositeRun[];
  section: DelegateCompositeSection;
}

export interface DelegateCompositeModel {
  groups: readonly DelegateCompositeGroup[];
  sections: readonly {
    id: DelegateCompositeSection;
    label: string;
    groups: readonly DelegateCompositeGroup[];
  }[];
}

const lifecycleReasons: readonly DelegateLifecycleReason[] = [
  'user-cancellation',
  'queued-cancellation',
  'timeout',
  'child-nonzero-exit',
  'provider-runner-error',
  'setup-failure',
  'lifecycle-cleanup-failure',
  'child-result-invalid',
  'unknown',
];

function lifecycleReason(value: string): DelegateLifecycleReason {
  return lifecycleReasons.includes(value as DelegateLifecycleReason)
    ? (value as DelegateLifecycleReason)
    : 'unknown';
}

function historyResult(
  details: DelegateHistoryDetails,
): DelegateResult | undefined {
  const result = details.structuredResult;
  if (!result) return undefined;
  return {
    kind: 'structured',
    status: result.valid ? 'valid' : 'invalid',
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.valueOmitted ? { valueOmitted: true } : {}),
    ...(result.errors.length ? { errors: result.errors } : {}),
  };
}

function historyTranscript(
  run: DelegateHistoryInvocation,
): DelegateTranscriptEntry[] {
  const task: DelegateTranscriptEntry[] = run.details.task
    ? [
        {
          id: `${run.runId}:task`,
          type: 'task',
          label: 'Task',
          text: run.details.task,
          status: 'completed',
          at: run.queuedAt ?? run.createdAt,
        },
      ]
    : [];
  const activities = (run.details.activities ?? []).map((activity, index) => ({
    id: activity.id ?? `${run.runId}:activity-${index}`,
    type: activity.type,
    label: activity.label,
    ...(activity.name ? { name: activity.name } : {}),
    ...(activity.arguments === undefined
      ? {}
      : { arguments: activity.arguments }),
    ...(activity.result === undefined ? {} : { result: activity.result }),
    ...(activity.argumentsTruncated ? { argumentsTruncated: true } : {}),
    ...(activity.resultTruncated ? { resultTruncated: true } : {}),
    ...(activity.text ? { text: activity.text } : {}),
    status: activity.status ?? 'completed',
    ...(activity.at === undefined ? {} : { at: activity.at }),
  })) satisfies DelegateTranscriptEntry[];
  const warnings = (run.details.warnings ?? []).map((warning, index) => ({
    id: `${run.runId}:warning-${index}`,
    type: 'assistant' as const,
    label: 'Warning',
    text: warning,
    status: 'completed' as const,
    at: run.finishedAt ?? run.createdAt,
  }));
  return [...task, ...activities, ...warnings];
}

function activitySummary(
  details: DelegateHistoryDetails,
): DelegatedActivity | undefined {
  const activity = details.activities?.at(-1);
  if (!activity) return undefined;
  return {
    id: activity.id,
    type: activity.type,
    label: activity.label,
    status: activity.status ?? 'completed',
    ...(activity.text ? { latestText: activity.text } : {}),
  };
}

/** Adapt one durable invocation to the existing live inspector row shape. */
export function delegateHistoryInvocationToStatus(
  run: DelegateHistoryInvocation,
): DelegateInspectionStatus {
  const lifecycle = run.details.lifecycle;
  return {
    id: run.runId,
    runId: run.runId,
    lineageId: run.lineageId,
    name: run.name,
    kind: run.kind,
    state: run.state,
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
    ...(run.route === undefined ? {} : { route: run.route }),
    ...(run.context === undefined ? {} : { context: run.context }),
    allowWrites: run.allowWrites,
    activity: activitySummary(run.details),
    runCount: 1,
    runs: [
      {
        state: run.state,
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      },
    ],
    transcript: historyTranscript(run),
    ...(run.details.truncated ? { transcriptTruncated: true } : {}),
    ...(historyResult(run.details)
      ? { result: historyResult(run.details) }
      : {}),
    ...(lifecycle
      ? {
          lifecycle: {
            reason: lifecycleReason(lifecycle.reason),
            ...(lifecycle.diagnostic === undefined
              ? {}
              : { diagnostic: lifecycle.diagnostic }),
            continuationUsable: lifecycle.continuationUsable,
            writableBranchRetained: lifecycle.writableBranchRetained,
            readOnlySnapshotRetained: lifecycle.readOnlySnapshotRetained,
          },
        }
      : {}),
    ...(run.details.warnings?.length ? { warnings: run.details.warnings } : {}),
    historical: true,
  };
}

function augmentLiveStatus(
  live: DelegateStatus,
  durable: DelegateInspectionStatus | undefined,
): DelegateInspectionStatus {
  if (!durable) return live;
  return {
    ...durable,
    ...live,
    // The live stream is authoritative for the current state, while durable
    // details fill the bounded fields the live surface does not carry.
    id: durable.id,
    transcript:
      live.transcript && live.transcript.length > 0
        ? live.transcript
        : durable.transcript,
    transcriptTruncated:
      live.transcriptTruncated === true || durable.transcriptTruncated === true,
    result: live.result ?? durable.result,
    lifecycle: live.lifecycle ?? durable.lifecycle,
    warnings: durable.warnings,
  } as DelegateInspectionStatus;
}

function timing(row: DelegateInspectionStatus) {
  return {
    state: row.state,
    ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
    ...(row.finishedAt === undefined ? {} : { finishedAt: row.finishedAt }),
  };
}

function sectionFor(
  row: DelegateStatus,
  hasLive: boolean,
): DelegateCompositeSection {
  if (isActiveDelegateStatus(row)) return 'active';
  return hasLive ? 'recent' : 'history';
}

export function isActiveDelegateStatus(row: DelegateStatus): boolean {
  return (
    row.pauseState === 'pausing' ||
    row.pauseState === 'paused' ||
    row.state === 'queued' ||
    row.state === 'running'
  );
}

function runLabel(
  index: number,
  row: DelegateStatus,
  current: boolean,
): string {
  const state = row.pauseState ?? row.state;
  return `${current ? 'Current · ' : ''}Run ${index + 1} · ${state}`;
}

function groupModel(
  group: DelegateHistoryGroup,
  live: DelegateStatus | undefined,
): DelegateCompositeGroup {
  const durableRuns = group.runs.map((run) => {
    const row = delegateHistoryInvocationToStatus(run);
    return {
      id: run.runId,
      label: '',
      row: group.truncated
        ? { ...row, transcriptTruncated: true, historyIncomplete: true }
        : row,
    };
  });
  const liveDurableIndex = live
    ? durableRuns.findIndex((run) => run.id === live.runId)
    : -1;
  const liveRow = live
    ? augmentLiveStatus(
        live,
        liveDurableIndex >= 0 ? durableRuns[liveDurableIndex]?.row : undefined,
      )
    : undefined;
  const incompleteLiveRow =
    liveRow && group.truncated
      ? { ...liveRow, transcriptTruncated: true, historyIncomplete: true }
      : liveRow;
  const runs = [...durableRuns];
  if (incompleteLiveRow) {
    if (liveDurableIndex >= 0) {
      runs[liveDurableIndex] = {
        id: incompleteLiveRow.runId,
        label: '',
        row: incompleteLiveRow,
      };
    } else {
      runs.push({
        id: incompleteLiveRow.runId,
        label: '',
        row: incompleteLiveRow,
      });
    }
  }
  const currentIndex = incompleteLiveRow
    ? runs.findIndex((run) => run.id === incompleteLiveRow.runId)
    : runs.length - 1;
  const labeledRuns = runs.map((run, index) => ({
    ...run,
    label: runLabel(index, run.row, index === currentIndex),
  }));
  const latest =
    (currentIndex >= 0 ? labeledRuns[currentIndex]?.row : undefined) ??
    labeledRuns.at(-1)?.row;
  if (!latest) throw new Error('Delegate history lineage has no runs.');
  const row: DelegateInspectionStatus = {
    ...latest,
    id: group.lineageId,
    lineageId: group.lineageId,
    runCount: labeledRuns.length,
    runs: labeledRuns.map((run) => timing(run.row)),
  };
  return {
    lineageId: group.lineageId,
    row,
    runs: labeledRuns,
    section: sectionFor(row, live !== undefined),
  };
}

function liveOnlyGroup(live: DelegateStatus): DelegateCompositeGroup {
  const row: DelegateInspectionStatus = { ...live, id: live.lineageId };
  return {
    lineageId: live.lineageId,
    row,
    runs: [
      {
        id: live.runId,
        label: `Current · Run ${live.runCount ?? 1}`,
        row: live,
      },
    ],
    section: sectionFor(live, true),
  };
}

/** Purely compose durable lineages with the current runtime projection. */
export function composeDelegateHistory(
  history: DelegateHistoryResponse | undefined,
  liveRows: readonly DelegateStatus[],
): DelegateCompositeModel {
  const liveByLineage = new Map(liveRows.map((row) => [row.lineageId, row]));
  const groups: DelegateCompositeGroup[] = [];
  for (const group of history?.groups ?? []) {
    const live = liveByLineage.get(group.lineageId);
    groups.push(groupModel(group, live));
    if (live) liveByLineage.delete(group.lineageId);
  }
  for (const live of liveByLineage.values()) groups.push(liveOnlyGroup(live));
  const sections = (
    [
      ['active', 'Active'],
      ['recent', 'Recent'],
      ['history', 'History'],
    ] as const
  ).map(([id, label]) => ({
    id,
    label,
    groups: groups.filter((group) => group.section === id),
  }));
  return { groups, sections };
}
