import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import { createLiveSurfacePublisher } from '../shared/runtime/live-surface-publisher';
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
) {
  const resultValue = status.result?.value;
  const resultValueLength =
    resultValue === undefined ? 0 : payloadLength(resultValue);
  const result = status.result
    ? {
        kind: status.result.kind,
        status: status.result.status,
        ...(status.result.errors?.length
          ? {
              errors: status.result.errors
                .slice(0, 16)
                .map((error) => text(error, 240)),
            }
          : {}),
        ...(resultValue === undefined
          ? status.result.valueOmitted
            ? { valueOmitted: true }
            : {}
          : resultValueLength <= surfaceBudget.remaining
            ? (() => {
                surfaceBudget.remaining -= resultValueLength;
                return { value: resultValue };
              })()
            : { valueOmitted: true }),
      }
    : undefined;
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
    ...(status.pauseState ? { pauseState: status.pauseState } : {}),
    ...(status.pausedAt === undefined ? {} : { pausedAt: status.pausedAt }),
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
    ...(result ? { result } : {}),
    ...(status.lifecycle
      ? {
          lifecycle: {
            reason: status.lifecycle.reason,
            ...(status.lifecycle.diagnostic !== undefined
              ? {
                  diagnostic: text(
                    status.lifecycle.diagnostic,
                    MAX_LIFECYCLE_DIAGNOSTIC_CHARS,
                  ),
                }
              : {}),
            ...(typeof status.lifecycle.diagnosticArtifact?.handle === 'string'
              ? {
                  diagnosticArtifact: {
                    handle: text(
                      status.lifecycle.diagnosticArtifact.handle,
                      256,
                    ),
                  },
                }
              : {}),
            continuationUsable: status.lifecycle.continuationUsable,
            writableBranchRetained: status.lifecycle.writableBranchRetained,
            readOnlySnapshotRetained: status.lifecycle.readOnlySnapshotRetained,
          },
        }
      : {}),
    ...transcriptSnapshot(status, surfaceBudget),
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
    const transcriptBudget = { remaining: MAX_TRANSCRIPT_SURFACE_CHARS };
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
    return {
      version: 1 as const,
      statuses: statuses.map((status) =>
        statusSnapshot(status, transcriptBudget),
      ),
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
