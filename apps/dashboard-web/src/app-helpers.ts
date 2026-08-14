import { type BridgeEvent, deriveSessionTitle } from '@pi-dashboard/protocol';

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
