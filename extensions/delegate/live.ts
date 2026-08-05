import { Value } from 'typebox/value';
import type { RuntimeExtensionSurface } from '../../packages/dashboard-protocol/src/index';
import {
  clearLiveExtensionSurfaces,
  publishLiveExtensionSurfaces,
} from '../shared/runtime/live-surfaces';
import {
  DELEGATE_RENDERER_ID,
  DELEGATE_SURFACE_ID,
  DelegateStatusViewModelSchema,
} from './contribution';
import type { DelegateStatusSnapshot, DelegateStatusStore } from './status';

export const DELEGATE_EXTENSION_ID = 'delegate';

function text(value: string, max: number): string {
  return value.slice(0, max);
}

function statusSnapshot(status: DelegateStatusSnapshot) {
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
  };
}

export function delegateSurface(
  store: DelegateStatusStore,
): RuntimeExtensionSurface {
  const viewModel = {
    version: 1 as const,
    statuses: store.list().slice(0, 64).map(statusSnapshot),
  };
  // Keep this check next to the adapter so a future status field cannot leak
  // into the bridge without a corresponding renderer contract change.
  if (!Value.Check(DelegateStatusViewModelSchema, viewModel))
    throw new Error('Delegate status surface is invalid.');
  return {
    id: DELEGATE_SURFACE_ID,
    rendererId: DELEGATE_RENDERER_ID,
    placement: 'right-rail',
    viewModel,
  };
}

export function publishDelegateSurface(store: DelegateStatusStore): void {
  publishLiveExtensionSurfaces(DELEGATE_EXTENSION_ID, [delegateSurface(store)]);
}

export function clearDelegateSurface(): void {
  clearLiveExtensionSurfaces(DELEGATE_EXTENSION_ID);
}
