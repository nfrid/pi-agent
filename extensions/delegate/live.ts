import {
  type ExtensionSurface,
  parseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import { Value } from 'typebox/value';
import {
  clearLiveExtensionSurfaces,
  publishLiveExtensionSurfaces,
} from '../shared/runtime/live-surfaces';
import type { SessionScopeId } from '../shared/runtime/scoped-services';
import {
  DELEGATE_RENDERER_ID,
  DELEGATE_SURFACE_ID,
  DelegateStatusViewModelSchema,
} from './contribution';
import type { DelegateStatusSnapshot, DelegateStatusStore } from './status';

export const DELEGATE_EXTENSION_ID = 'delegate';
const MAX_SURFACE_STATUSES = 24;
const MAX_TRANSCRIPT_SURFACE_CHARS = 96_000;

function text(value: string, max: number): string {
  return value.slice(0, max);
}

function transcriptSnapshot(
  status: DelegateStatusSnapshot,
  budget: { remaining: number },
) {
  const entries = status.transcript ?? [];
  const projected = [];
  let truncated = status.transcriptTruncated === true;
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
    if (entry.text && value?.length !== entry.text.length) truncated = true;
    const cost = label.length + (value?.length ?? 0) + 64;
    if (cost > budget.remaining) {
      truncated = true;
      break;
    }
    budget.remaining -= cost;
    projected.push({
      id: text(entry.id, 512) || `${entry.type}-${projected.length}`,
      type: entry.type,
      label,
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
  transcriptBudget: { remaining: number },
) {
  return {
    id: text(status.id, 256),
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
    ...(status.context ? { context: status.context } : {}),
    allowWrites: status.allowWrites,
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
              ? { latestText: text(status.activity.latestText, 10_000) }
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
    ...(status.lifecycle
      ? {
          lifecycle: {
            reason: status.lifecycle.reason,
            ...(status.lifecycle.diagnostic !== undefined
              ? { diagnostic: status.lifecycle.diagnostic }
              : {}),
            ...(status.lifecycle.diagnosticArtifact
              ? {
                  diagnosticArtifact: {
                    ...status.lifecycle.diagnosticArtifact,
                  },
                }
              : {}),
            continuationUsable: status.lifecycle.continuationUsable,
            writableBranchRetained: status.lifecycle.writableBranchRetained,
            readOnlySnapshotRetained: status.lifecycle.readOnlySnapshotRetained,
          },
        }
      : {}),
    ...transcriptSnapshot(status, transcriptBudget),
  };
}

export function delegateSurface(store: DelegateStatusStore): ExtensionSurface {
  const transcriptBudget = { remaining: MAX_TRANSCRIPT_SURFACE_CHARS };
  const statuses = store
    .list()
    .sort((left, right) => {
      const leftActive = left.state === 'queued' || left.state === 'running';
      const rightActive = right.state === 'queued' || right.state === 'running';
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return right.createdAt - left.createdAt;
    })
    .slice(0, MAX_SURFACE_STATUSES);
  const viewModel = {
    version: 1 as const,
    statuses: statuses.map((status) =>
      statusSnapshot(status, transcriptBudget),
    ),
  };
  // Keep this check next to the adapter so a future status field cannot leak
  // into the bridge without a corresponding renderer contract change.
  if (!Value.Check(DelegateStatusViewModelSchema, viewModel))
    throw new Error('Delegate status surface is invalid.');
  return parseExtensionSurface({
    id: DELEGATE_SURFACE_ID,
    rendererId: DELEGATE_RENDERER_ID,
    placement: 'right-rail',
    viewModel,
  });
}

export function publishDelegateSurface(
  store: DelegateStatusStore,
  scopeId?: SessionScopeId,
): void {
  publishLiveExtensionSurfaces(
    DELEGATE_EXTENSION_ID,
    [delegateSurface(store)],
    scopeId,
  );
}

export function clearDelegateSurface(scopeId?: SessionScopeId): void {
  clearLiveExtensionSurfaces(DELEGATE_EXTENSION_ID, scopeId);
}
