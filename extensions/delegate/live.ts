import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import { createLiveSurfacePublisher } from '../shared/runtime/live-surface-publisher';
import type { SessionScopeId } from '../shared/runtime/scoped-services';
import {
  DELEGATE_RENDERER_ID,
  DELEGATE_SURFACE_ID,
  DelegateStatusViewModelSchema,
} from './contribution';
import type { DelegateStatusSnapshot, DelegateStatusStore } from './status';
import type { DelegateLiveDetails } from './types';

export const DELEGATE_EXTENSION_ID = 'delegate';
const MAX_SURFACE_STATUSES = 24;
// Routine surfaces carry row metadata; active transcript authority is replayed
// separately and bounded per lineage so one busy delegate cannot starve another.
const MAX_SURFACE_DETAIL_CHARS = 14 * 1024;
const MAX_ACTIVE_TRANSCRIPT_CHARS = 16 * 1024;
const MAX_LIFECYCLE_DIAGNOSTIC_CHARS = 4_000;

function text(value: string, max: number): string {
  return value.slice(0, max);
}

function payloadLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function takeValue(
  value: unknown,
  budget: { remaining: number },
): { included: true; value: unknown } | { included: false } {
  const size = payloadLength(value);
  if (size > budget.remaining) return { included: false };
  budget.remaining -= size;
  return { included: true, value };
}

function takeText(
  value: string,
  max: number,
  budget: { remaining: number },
): string | undefined {
  const result = text(value, Math.min(max, budget.remaining));
  if (!result) return undefined;
  budget.remaining -= result.length;
  return result;
}

const MAX_SURFACE_TASK_CHARS = 4 * 1024;

function projectDetails(
  details: DelegateLiveDetails,
  budget: { remaining: number },
  includePrompt: boolean,
): DelegateLiveDetails {
  let truncated = details.truncated;
  const task = details.task
    ? takeText(details.task, MAX_SURFACE_TASK_CHARS, budget)
    : undefined;
  if (details.task && task?.length !== details.task.length) truncated = true;

  const setup: NonNullable<DelegateLiveDetails['setup']> = {};
  if (details.setup?.cwd) {
    const cwd = takeText(details.setup.cwd, 4_096, budget);
    if (cwd) setup.cwd = cwd;
    if (cwd?.length !== details.setup.cwd.length) truncated = true;
  }
  if (details.setup?.isolation) setup.isolation = details.setup.isolation;
  if (details.setup?.worktree) {
    const worktree: NonNullable<
      NonNullable<DelegateLiveDetails['setup']>['worktree']
    > = {};
    for (const [key, max] of [
      ['branch', 512],
      ['worktreePath', 4_096],
      ['repositoryRoot', 4_096],
      ['baseHead', 256],
      ['baseRef', 512],
      ['workBase', 256],
    ] as const) {
      const value = details.setup.worktree[key];
      if (!value) continue;
      const projected = takeText(value, max, budget);
      if (projected) worktree[key] = projected;
      if (projected?.length !== value.length) truncated = true;
    }
    if (Object.keys(worktree).length) setup.worktree = worktree;
  }

  const runConfig: NonNullable<DelegateLiveDetails['runConfig']> = {};
  const sourceConfig = details.runConfig;
  if (sourceConfig?.scope) {
    const scope = sourceConfig.scope.flatMap((value) => {
      const projected = takeText(value, 4_096, budget);
      if (projected?.length !== value.length) truncated = true;
      return projected ? [projected] : [];
    });
    if (scope.length) runConfig.scope = scope;
    if (scope.length !== sourceConfig.scope.length) truncated = true;
  }
  if (sourceConfig?.after) {
    const after = sourceConfig.after.flatMap((value) => {
      const projected = takeText(value, 80, budget);
      if (projected?.length !== value.length) truncated = true;
      return projected ? [projected] : [];
    });
    if (after.length) runConfig.after = after;
    if (after.length !== sourceConfig.after.length) truncated = true;
  }
  if (sourceConfig?.inputs) {
    const inputs = sourceConfig.inputs.flatMap((input) => {
      const included = takeValue(input, budget);
      if (!included.included) {
        truncated = true;
        return [];
      }
      return [included.value as (typeof sourceConfig.inputs)[number]];
    });
    if (inputs.length) runConfig.inputs = inputs;
    if (inputs.length !== sourceConfig.inputs.length) truncated = true;
  }
  if (sourceConfig?.parentContextNote) {
    const note = takeText(sourceConfig.parentContextNote, 64 * 1024, budget);
    if (note) runConfig.parentContextNote = note;
    if (note?.length !== sourceConfig.parentContextNote.length)
      truncated = true;
  }
  if (sourceConfig?.refreshSource)
    runConfig.refreshSource = sourceConfig.refreshSource;
  if (sourceConfig?.warnings) {
    const warnings = sourceConfig.warnings.flatMap((warning) => {
      const projected = takeText(warning, 512, budget);
      if (projected?.length !== warning.length) truncated = true;
      return projected ? [projected] : [];
    });
    if (warnings.length) runConfig.warnings = warnings;
    if (warnings.length !== sourceConfig.warnings.length) truncated = true;
  }

  const renderedPrompt =
    includePrompt && details.renderedPrompt
      ? (() => {
          const included = takeValue(details.renderedPrompt, budget);
          if (!included.included) {
            truncated = true;
            return undefined;
          }
          return included.value as string;
        })()
      : undefined;
  return {
    ...(task ? { task } : {}),
    ...(Object.keys(setup).length ? { setup } : {}),
    ...(Object.keys(runConfig).length ? { runConfig } : {}),
    ...(renderedPrompt ? { renderedPrompt } : {}),
    truncated,
  };
}

function projectPrompt(
  details: DelegateLiveDetails,
  projected: DelegateLiveDetails,
  budget: { remaining: number },
): DelegateLiveDetails {
  if (!details.renderedPrompt) return projected;
  const included = takeValue(details.renderedPrompt, budget);
  return included.included
    ? { ...projected, renderedPrompt: included.value as string }
    : { ...projected, truncated: true };
}

function detailProjections(
  statuses: readonly DelegateStatusSnapshot[],
  budget: { remaining: number },
): ReadonlyMap<string, DelegateLiveDetails> {
  const active = statuses.filter(
    (status) =>
      (status.state === 'queued' || status.state === 'running') &&
      status.details,
  );
  const projections = new Map<string, DelegateLiveDetails>();
  let remainingRows = active.length;
  for (const status of active) {
    const share = Math.floor(budget.remaining / remainingRows);
    const rowBudget = { remaining: share };
    projections.set(
      status.id,
      projectDetails(status.details as DelegateLiveDetails, rowBudget, false),
    );
    budget.remaining -= share - rowBudget.remaining;
    remainingRows -= 1;
  }
  remainingRows = active.filter(
    (status) => status.details?.renderedPrompt,
  ).length;
  for (const status of active) {
    if (!status.details?.renderedPrompt) continue;
    const share = remainingRows
      ? Math.floor(budget.remaining / remainingRows)
      : 0;
    const rowBudget = { remaining: share };
    const current = projections.get(status.id);
    if (current) {
      projections.set(
        status.id,
        projectPrompt(status.details, current, rowBudget),
      );
    }
    budget.remaining -= share - rowBudget.remaining;
    remainingRows -= 1;
  }
  return projections;
}

function transcriptSnapshot(
  status: DelegateStatusSnapshot,
  budget: { remaining: number },
) {
  const entries = status.transcript ?? [];
  const projected = [];
  let truncated = status.transcriptTruncated === true;
  if (budget.remaining <= 0)
    return truncated ? { transcriptTruncated: true } : {};
  for (const entry of entries) {
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    const label = text(entry.label, 2_000) || entry.type;
    const textBudget = Math.max(
      0,
      Math.min(8_000, budget.remaining - label.length - 64),
    );
    const value = entry.text ? text(entry.text, textBudget) : undefined;
    const argumentsValue = entry.arguments;
    const resultValue = entry.result;
    if (entry.text && value?.length !== entry.text.length) truncated = true;
    const cost =
      label.length +
      (value?.length ?? 0) +
      payloadLength(argumentsValue) +
      payloadLength(resultValue) +
      96;
    if (cost > budget.remaining) {
      truncated = true;
      break;
    }
    budget.remaining -= cost;
    projected.push({
      id: text(entry.id, 512) || `${entry.type}-${projected.length}`,
      type: entry.type,
      label,
      ...(entry.name ? { name: text(entry.name, 256) } : {}),
      ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
      ...(resultValue === undefined ? {} : { result: resultValue }),
      ...(entry.argumentsTruncated ? { argumentsTruncated: true } : {}),
      ...(entry.resultTruncated ? { resultTruncated: true } : {}),
      ...(value ? { text: value } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.at === undefined ? {} : { at: entry.at }),
      ...(entry.run === undefined ? {} : { run: entry.run }),
    });
  }
  return {
    ...(projected.length > 0 ? { transcript: projected } : {}),
    ...(truncated ? { transcriptTruncated: true } : {}),
  };
}

function statusSnapshot(
  status: DelegateStatusSnapshot,
  surfaceBudget: { remaining: number },
  details: DelegateLiveDetails | undefined,
) {
  const active = status.state === 'queued' || status.state === 'running';
  return {
    id: text(status.id, 256),
    runId: text(status.runId, 256),
    ...(status.sessionId ? { sessionId: text(status.sessionId, 256) } : {}),
    lineageId: text(status.lineageId, 256),
    name: text(status.name, 2_000) || 'Subagent',
    kind: status.kind,
    state: status.state,
    createdAt: status.createdAt,
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.finishedAt === undefined
      ? {}
      : { finishedAt: status.finishedAt }),
    ...(status.jobId ? { jobId: text(status.jobId, 256) } : {}),
    ...(status.route ? { route: text(status.route, 512) } : {}),
    ...(status.context
      ? (() => {
          const included = takeValue(status.context, surfaceBudget);
          return included.included ? { context: included.value } : {};
        })()
      : {}),
    allowWrites: status.allowWrites,
    ...(status.capabilities?.length
      ? { capabilities: [...status.capabilities] }
      : {}),
    ...(status.pauseState ? { pauseState: status.pauseState } : {}),
    ...(status.pausedAt === undefined ? {} : { pausedAt: status.pausedAt }),
    ...(active && details ? { details } : {}),
    ...(status.activity
      ? {
          activity: {
            ...(status.activity.id
              ? { id: text(status.activity.id, 256) }
              : {}),
            type: status.activity.type,
            label: text(status.activity.label, 2_000),
            status: status.activity.status,
            ...(status.activity.latestText
              ? (() => {
                  const latestText = takeText(
                    status.activity.latestText,
                    2_000,
                    surfaceBudget,
                  );
                  return latestText ? { latestText } : {};
                })()
              : {}),
          },
        }
      : {}),
    ...(status.runCount === undefined ? {} : { runCount: status.runCount }),
    ...(status.runs
      ? {
          runs: status.runs.slice(0, 64).map((run) => ({
            state: run.state,
            ...(run.startedAt === undefined
              ? {}
              : { startedAt: run.startedAt }),
            ...(run.finishedAt === undefined
              ? {}
              : { finishedAt: run.finishedAt }),
          })),
        }
      : {}),
    ...(status.workflow
      ? {
          workflow: {
            logicalId: text(status.workflow.logicalId, 64),
            attempt: status.workflow.attempt,
            identity: text(status.workflow.identity, 80),
            state: status.workflow.state,
            dependencies: status.workflow.dependencies
              .slice(0, 32)
              .map((identity) => text(identity, 80)),
            ...(status.workflow.inputs?.length
              ? {
                  inputs: status.workflow.inputs.slice(0, 4).map((input) => ({
                    node: text(input.node, 80),
                    identity: text(input.identity, 80),
                    ...(input.include
                      ? { include: input.include.slice(0, 4) }
                      : {}),
                    ...(input.label ? { label: text(input.label, 120) } : {}),
                  })),
                }
              : {}),
            ...(status.workflow.waitingFor
              ? {
                  waitingFor: status.workflow.waitingFor
                    .slice(0, 32)
                    .map((identity) => text(identity, 80)),
                }
              : {}),
            ...(status.workflow.reason
              ? { reason: text(status.workflow.reason, 256) }
              : {}),
            ...(status.workflow.route
              ? { route: text(status.workflow.route, 512) }
              : {}),
            createdAt: status.workflow.createdAt,
            scheduledAt: status.workflow.scheduledAt,
            ...(status.workflow.queuedAt === undefined
              ? {}
              : { queuedAt: status.workflow.queuedAt }),
            ...(status.workflow.startedAt === undefined
              ? {}
              : { startedAt: status.workflow.startedAt }),
            ...(status.workflow.settledAt === undefined
              ? {}
              : { settledAt: status.workflow.settledAt }),
            ...(status.lifecycle
              ? {
                  branchAvailable: status.lifecycle.writableBranchRetained,
                  snapshotAvailable: status.lifecycle.readOnlySnapshotRetained,
                }
              : {}),
            ...(status.workflow.deliveredToParent
              ? { deliveredToParent: true }
              : {}),
          },
        }
      : {}),
    ...(status.lifecycle
      ? {
          lifecycle: {
            reason: status.lifecycle.reason,
            ...(status.lifecycle.diagnostic !== undefined
              ? (() => {
                  const diagnostic = takeText(
                    status.lifecycle.diagnostic,
                    MAX_LIFECYCLE_DIAGNOSTIC_CHARS,
                    surfaceBudget,
                  );
                  return diagnostic === undefined ? {} : { diagnostic };
                })()
              : {}),
            ...(typeof status.lifecycle.diagnosticFile?.path === 'string'
              ? {
                  diagnosticFile: {
                    path: text(status.lifecycle.diagnosticFile.path, 4096),
                    size: status.lifecycle.diagnosticFile.size,
                  },
                }
              : {}),
            continuationUsable: status.lifecycle.continuationUsable,
            writableBranchRetained: status.lifecycle.writableBranchRetained,
            readOnlySnapshotRetained: status.lifecycle.readOnlySnapshotRetained,
          },
        }
      : {}),
    // Settled transcript detail is owned by persisted delegate history. Active
    // rows retain an independent bounded authority for baseline/reconnect replay.
    ...transcriptSnapshot(status, {
      remaining: active ? MAX_ACTIVE_TRANSCRIPT_CHARS : 0,
    }),
  };
}

const publisher = createLiveSurfacePublisher<DelegateStatusStore>({
  extensionId: DELEGATE_EXTENSION_ID,
  surfaceId: DELEGATE_SURFACE_ID,
  rendererId: DELEGATE_RENDERER_ID,
  placement: 'right-rail',
  viewModelSchema: DelegateStatusViewModelSchema,
  invalidMessage: 'Delegate status surface is invalid.',
  buildViewModel: (store) => {
    const surfaceBudget = { remaining: MAX_SURFACE_DETAIL_CHARS };
    const statuses = store
      .list()
      .sort((left, right) => {
        const leftActive = left.state === 'queued' || left.state === 'running';
        const rightActive =
          right.state === 'queued' || right.state === 'running';
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        return right.createdAt - left.createdAt;
      })
      .slice(0, MAX_SURFACE_STATUSES);
    const details = detailProjections(statuses, surfaceBudget);
    return {
      version: 1 as const,
      statuses: statuses.map((status) =>
        statusSnapshot(status, surfaceBudget, details.get(status.id)),
      ),
      wakes: store
        .getWakes()
        .slice(0, 256)
        .map((wake) => ({
          id: text(wake.id, 64),
          state: wake.state,
          references: wake.references
            .slice(0, 32)
            .map((identity) => text(identity, 80)),
          ...(wake.waitingFor
            ? {
                waitingFor: wake.waitingFor
                  .slice(0, 32)
                  .map((identity) => text(identity, 80)),
              }
            : {}),
          createdAt: wake.createdAt,
          ...(wake.readyAt === undefined ? {} : { readyAt: wake.readyAt }),
          ...(wake.queuedAt === undefined ? {} : { queuedAt: wake.queuedAt }),
          ...(wake.enteredAt === undefined
            ? {}
            : { enteredAt: wake.enteredAt }),
          ...(wake.cancelledAt === undefined
            ? {}
            : { cancelledAt: wake.cancelledAt }),
          ...(wake.blockedAt === undefined
            ? {}
            : { blockedAt: wake.blockedAt }),
          ...(wake.reason ? { reason: text(wake.reason, 256) } : {}),
        })),
    };
  },
});

export function delegateSurface(store: DelegateStatusStore): ExtensionSurface {
  return publisher.surface(store);
}

export function publishDelegateSurface(
  store: DelegateStatusStore,
  scopeId?: SessionScopeId,
): void {
  publisher.publish(store, scopeId);
}

export function clearDelegateSurface(scopeId?: SessionScopeId): void {
  publisher.clear(scopeId);
}
