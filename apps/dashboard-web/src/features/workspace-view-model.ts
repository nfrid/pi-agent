import type {
  RuntimeSnapshot,
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';

const runtimeStateOrder: Record<RuntimeSnapshot['liveState'], number> = {
  failed: 0,
  waiting: 1,
  working: 2,
  compacting: 3,
  aborting: 4,
  stopping: 5,
  idle: 6,
};

/** Keep attention-worthy and connected runtimes at the top without mutating the snapshot. */
export function sortWorkspaceRuntimes(
  runtimes: readonly RuntimeSnapshot[],
): RuntimeSnapshot[] {
  return [...runtimes].sort((a, b) => {
    const onlineOrder = Number(b.online !== false) - Number(a.online !== false);
    if (onlineOrder) return onlineOrder;
    const stateOrder =
      runtimeStateOrder[a.liveState] - runtimeStateOrder[b.liveState];
    if (stateOrder) return stateOrder;
    const seenOrder = (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
    return seenOrder || a.runtimeId.localeCompare(b.runtimeId);
  });
}

/** Recent means the catalogue's durable updated timestamp, newest first. */
export function sortWorkspaceSessions(
  sessions: readonly SessionIndexEntry[],
): SessionIndexEntry[] {
  return [...sessions].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
  );
}

export type WorkspaceReadiness = 'ready' | 'offline' | 'unknown';

export type WorkspaceSummary = {
  readiness: WorkspaceReadiness;
  runtimeCount: number;
  liveRuntimeCount: number;
  sessionCount: number;
  latestSession?: SessionIndexEntry;
};

export function summarizeWorkspace(
  workspace: WorkspaceTarget | undefined,
  runtimes: readonly RuntimeSnapshot[],
  sessions: readonly SessionIndexEntry[],
): WorkspaceSummary {
  const liveRuntimeCount = runtimes.filter(
    (runtime) => runtime.online !== false,
  ).length;
  const readiness: WorkspaceReadiness = !workspace
    ? 'unknown'
    : liveRuntimeCount > 0
      ? 'ready'
      : 'offline';
  return {
    readiness,
    runtimeCount: runtimes.length,
    liveRuntimeCount,
    sessionCount: sessions.length,
    latestSession: sortWorkspaceSessions(sessions)[0],
  };
}
