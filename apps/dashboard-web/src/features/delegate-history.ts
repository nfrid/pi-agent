import type {
  DelegateHistoryDetails,
  DelegateHistoryGroup,
  DelegateHistoryInvocation,
  DelegateHistoryResponse,
  DelegateHistoryRunDetail,
  DelegateWakeMetadata,
} from '@pi-dashboard/protocol';
import type {
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
  wake?: DelegateWakeMetadata;
};

export interface DelegateCompositeRun {
  id: string;
  label: string;
  row: DelegateInspectionStatus;
  persisted?: boolean;
  live?: boolean;
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
  'unknown',
];

function legacyHistoryState(
  state: DelegateHistoryInvocation['state'],
): DelegateStatus['state'] {
  if (state === 'scheduled') return 'queued';
  if (state === 'cancelled' || state === 'blocked') return 'error';
  return state;
}

function lifecycleReason(value: string): DelegateLifecycleReason {
  return lifecycleReasons.includes(value as DelegateLifecycleReason)
    ? (value as DelegateLifecycleReason)
    : 'unknown';
}

function historyTranscript(
  run: DelegateHistoryInvocation,
  details: DelegateHistoryDetails | undefined,
): DelegateTranscriptEntry[] {
  if (!details) return [];
  const task: DelegateTranscriptEntry[] = details.task
    ? [
        {
          id: `${run.runId}:task`,
          type: 'task',
          label: 'Task',
          text: details.task,
          status: 'completed',
          at: run.queuedAt ?? run.createdAt,
        },
      ]
    : [];
  const activities = (details.activities ?? []).map((activity, index) => ({
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
  const response: DelegateTranscriptEntry[] = details.response
    ? [
        {
          id: `${run.runId}:response`,
          type: 'assistant',
          label: 'Response',
          text: details.response,
          status: 'completed',
          at: run.finishedAt ?? run.createdAt,
        },
      ]
    : [];
  const error: DelegateTranscriptEntry[] = details.error
    ? [
        {
          id: `${run.runId}:error`,
          type: 'error',
          label: 'Error',
          text: details.error,
          status: 'error',
          at: run.finishedAt ?? run.createdAt,
        },
      ]
    : [];
  const warnings = (details.warnings ?? []).map((warning, index) => ({
    id: `${run.runId}:warning-${index}`,
    type: 'assistant' as const,
    label: 'Warning',
    text: warning,
    status: 'completed' as const,
    at: run.finishedAt ?? run.createdAt,
  }));
  return [...task, ...activities, ...response, ...error, ...warnings];
}

function activitySummary(
  details: DelegateHistoryDetails | undefined,
): DelegatedActivity | undefined {
  const activity = details?.activities?.at(-1);
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
  run: DelegateHistoryInvocation | DelegateHistoryRunDetail,
  explicitDetails?: DelegateHistoryDetails,
): DelegateInspectionStatus {
  // The optional compatibility read keeps this adapter useful to callers that
  // still hold an older in-memory response, while the v2 wire summary never
  // contains this property.
  const details =
    explicitDetails ??
    ('details' in run && run.details ? run.details : undefined);
  const lifecycle = details?.lifecycle;
  return {
    id: run.runId,
    runId: run.runId,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
    lineageId: run.lineageId,
    name: run.name,
    kind: run.kind,
    state: legacyHistoryState(run.state),
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
    ...(run.route === undefined ? {} : { route: run.route }),
    ...(run.context === undefined ? {} : { context: run.context }),
    allowWrites: run.allowWrites,
    ...(run.workflow
      ? {
          workflow: {
            ...run.workflow,
            dependencies: [...run.workflow.dependencies],
            ...(run.workflow.waitingFor
              ? { waitingFor: [...run.workflow.waitingFor] }
              : {}),
          },
        }
      : {}),
    ...(run.wake
      ? { wake: { ...run.wake, references: [...run.wake.references] } }
      : {}),
    activity: activitySummary(details),
    runCount: 1,
    runs: [
      {
        state: legacyHistoryState(run.state),
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      },
    ],
    transcript: historyTranscript(run, details),
    ...(details?.truncated ? { transcriptTruncated: true } : {}),
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
    ...(details?.warnings?.length ? { warnings: details.warnings } : {}),
    historical: true,
  };
}

function liveCurrentRunStatus(live: DelegateStatus): DelegateStatus {
  const currentRun = live.runCount ?? live.runs?.length ?? 1;
  if (!live.transcript) return live;
  return {
    ...live,
    // A live lineage row is aggregate, but each inspector option must expose
    // only the transcript segment belonging to that invocation.
    transcript: live.transcript.filter(
      (entry) =>
        entry.run === currentRun ||
        (currentRun === 1 && entry.run === undefined),
    ),
  };
}

function augmentLiveStatus(
  live: DelegateStatus,
  durable: DelegateInspectionStatus | undefined,
): DelegateInspectionStatus {
  const currentLive = liveCurrentRunStatus(live);
  if (!durable) return currentLive;
  return {
    ...durable,
    ...currentLive,
    // The live stream is authoritative for the current state, while durable
    // details fill the bounded fields the live surface does not carry.
    id: durable.id,
    transcript:
      currentLive.transcript && currentLive.transcript.length > 0
        ? currentLive.transcript
        : durable.transcript,
    transcriptTruncated:
      currentLive.transcriptTruncated === true ||
      durable.transcriptTruncated === true,
    lifecycle: currentLive.lifecycle ?? durable.lifecycle,
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

/** IDs whose durable state proves that a live settlement has been persisted. */
export function delegateHistorySettledRunIds(
  history: DelegateHistoryResponse | undefined,
): ReadonlySet<string> {
  return new Set(
    history?.groups.flatMap((group) => {
      const groupSettled =
        group.state !== 'queued' && group.state !== 'running';
      return group.runs
        .filter(
          (run) =>
            (run.state !== 'queued' && run.state !== 'running') ||
            (groupSettled && run.runId === group.runId),
        )
        .map((run) => run.runId);
    }) ?? [],
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
  const durableRuns: DelegateCompositeRun[] = group.runs.map((run) => {
    const row = delegateHistoryInvocationToStatus(run);
    return {
      id: run.runId,
      label: '',
      persisted: true,
      row: group.truncated
        ? { ...row, transcriptTruncated: true, historyIncomplete: true }
        : row,
    };
  });
  const liveDurableIndex = live
    ? durableRuns.findIndex(
        (run) =>
          run.id === live.runId ||
          (live.jobId !== undefined && run.row.jobId === live.jobId),
      )
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
        persisted: true,
        live: true,
        row: incompleteLiveRow,
      };
    } else {
      runs.push({
        id: incompleteLiveRow.runId,
        label: '',
        persisted: false,
        live: true,
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
  const current = liveCurrentRunStatus(live);
  const row: DelegateInspectionStatus = { ...current, id: live.lineageId };
  return {
    lineageId: live.lineageId,
    row,
    runs: [
      {
        id: current.runId,
        label: `Current · Run ${current.runCount ?? 1}`,
        persisted: false,
        live: true,
        row: current,
      },
    ],
    section: sectionFor(current, true),
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
