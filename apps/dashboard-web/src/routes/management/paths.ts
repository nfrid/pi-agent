import type {
  BrowserSnapshot,
  ProjectSummary,
  SessionIndexEntry,
} from '@pi-dashboard/protocol';

function normalizedPath(value: string): string {
  const trimmed = value.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
  return trimmed || '/';
}

export function pathWithin(child: string, parent: string): boolean {
  const normalizedChild = normalizedPath(child);
  const normalizedParent = normalizedPath(parent);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(
      `${normalizedParent === '/' ? '' : normalizedParent}/`,
    )
  );
}

export function unassignedSessions(
  snapshot: BrowserSnapshot,
  project: ProjectSummary,
): readonly SessionIndexEntry[] {
  const checkouts = (snapshot.checkouts ?? []).filter(
    (checkout) =>
      checkout.projectId === project.id &&
      (checkout.status === 'ready' || checkout.status === 'dirty'),
  );
  const owned = new Set(
    (snapshot.runs ?? []).map((run) => run.piSessionId).filter(Boolean),
  );
  return snapshot.sessions.filter(
    (session) =>
      !owned.has(session.id) &&
      checkouts.some((checkout) => pathWithin(session.cwd, checkout.path)),
  );
}
