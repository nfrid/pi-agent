import {
  type BridgeEvent,
  type BrowserSnapshot,
  deriveSessionTitle,
  workspaceForPath,
} from '@pi-dashboard/protocol';

/**
 * Return workspace presentation order without mutating the protocol snapshot.
 * Indexed sessions may omit workspaceId, so their cwd is resolved against the
 * same catalogue used by the rest of the dashboard.
 */
export function sortWorkspacesByRecency(
  snapshot: Pick<BrowserSnapshot, 'workspaces' | 'sessions'>,
): BrowserSnapshot['workspaces'] {
  const latestByWorkspace = new Map<string, number>();
  for (const session of snapshot.sessions) {
    const workspace =
      snapshot.workspaces.find(
        (candidate) => candidate.id === session.workspaceId,
      ) ?? workspaceForPath(session.cwd, snapshot.workspaces);
    if (!workspace) continue;
    const latest = latestByWorkspace.get(workspace.id);
    if (latest === undefined || session.updatedAt > latest)
      latestByWorkspace.set(workspace.id, session.updatedAt);
  }
  return snapshot.workspaces
    .map((workspace, index) => ({
      workspace,
      index,
      latest: latestByWorkspace.get(workspace.id),
    }))
    .sort(
      (left, right) =>
        (right.latest === undefined ? -Infinity : right.latest) -
          (left.latest === undefined ? -Infinity : left.latest) ||
        left.index - right.index,
    )
    .map(({ workspace }) => workspace);
}

export function sessionDisplayTitle(
  session: { name?: string; title?: string },
  entries: readonly unknown[] = [],
): string {
  return (
    session.name ??
    session.title ??
    deriveSessionTitle(entries) ??
    'Untitled session'
  );
}

export function isNearPageBottom(
  scrollHeight: number,
  scrollY: number,
  innerHeight: number,
  threshold = 120,
): boolean {
  return scrollHeight - scrollY - innerHeight <= threshold;
}

export function shouldShowJumpToLatest(
  scrollHeight: number,
  scrollY: number,
  innerHeight: number,
  threshold = 120,
): boolean {
  return !isNearPageBottom(scrollHeight, scrollY, innerHeight, threshold);
}

export function shouldApplySessionMetadata(
  eventCursor: number,
  metadataCursor: number,
): boolean {
  return eventCursor > metadataCursor;
}

export function sessionNavigationTarget(
  currentSessionId: string,
  associatedRuntimeId: string | undefined,
  eventRuntimeId: string | undefined,
  event: Extract<BridgeEvent, { type: 'session.changed' | 'session.snapshot' }>,
): string | undefined {
  if (
    (event.type !== 'session.changed' && event.type !== 'session.snapshot') ||
    associatedRuntimeId === undefined ||
    eventRuntimeId !== associatedRuntimeId
  )
    return undefined;
  const nextSessionId = event.session.id;
  return nextSessionId !== currentSessionId ? nextSessionId : undefined;
}
