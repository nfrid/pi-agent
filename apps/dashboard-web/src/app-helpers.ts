import { deriveSessionTitle } from '@pi-dashboard/protocol';
import type { DashboardEvent } from './dashboard-transport';

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

export function sessionCursorRangeCovered(
  snapshotCursor: number,
  currentCursor: number,
  cursorHistory: readonly number[],
): boolean {
  if (currentCursor <= snapshotCursor) return true;
  let expected = snapshotCursor + 1;
  for (const cursor of cursorHistory) {
    if (cursor < expected) continue;
    if (cursor !== expected) return false;
    expected += 1;
    if (expected > currentCursor) return true;
  }
  return expected > currentCursor;
}

export function sessionNavigationTarget(
  currentSessionId: string,
  associatedRuntimeId: string | undefined,
  eventRuntimeId: string | undefined,
  event: DashboardEvent['event'],
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
