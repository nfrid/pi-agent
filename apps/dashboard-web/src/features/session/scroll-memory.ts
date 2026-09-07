const SESSION_SCROLL_MEMORY_VERSION = 1;
const SESSION_SCROLL_MEMORY_PREFIX = 'pi.dashboard.session-scroll.v1:';

export type SessionFollowMode = 'following' | 'manual';

export type SessionScrollMemory = {
  version: typeof SESSION_SCROLL_MEMORY_VERSION;
  mode: SessionFollowMode;
  rowKey?: string;
  rowOffset?: number;
  scrollTop: number;
  oldestOrdinal?: number;
};

export function sessionScrollMemoryKey(
  sessionId: string,
  serverId: string,
): string {
  return `${SESSION_SCROLL_MEMORY_PREFIX}${serverId}:${sessionId}`;
}

export function readSessionScrollMemory(
  sessionId: string,
  serverId: string,
): SessionScrollMemory | undefined {
  try {
    const raw = window.sessionStorage.getItem(
      sessionScrollMemoryKey(sessionId, serverId),
    );
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<SessionScrollMemory>;
    if (
      value.version !== SESSION_SCROLL_MEMORY_VERSION ||
      (value.mode !== 'following' && value.mode !== 'manual') ||
      typeof value.scrollTop !== 'number' ||
      !Number.isFinite(value.scrollTop) ||
      (value.rowKey !== undefined && typeof value.rowKey !== 'string') ||
      (value.rowOffset !== undefined &&
        (typeof value.rowOffset !== 'number' ||
          !Number.isFinite(value.rowOffset))) ||
      (value.oldestOrdinal !== undefined &&
        (typeof value.oldestOrdinal !== 'number' ||
          !Number.isFinite(value.oldestOrdinal)))
    )
      return undefined;
    return value as SessionScrollMemory;
  } catch {
    return undefined;
  }
}

export function writeSessionScrollMemory(
  key: string,
  memory: SessionScrollMemory,
): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(memory));
  } catch {
    // Storage is optional (privacy mode, quota, and disabled browser storage).
  }
}

export function visibleTranscriptAnchor(element: HTMLDivElement) {
  const viewportTop = element.getBoundingClientRect().top;
  const row = Array.from(
    element.querySelectorAll<HTMLElement>(
      '[data-transcript-key], [data-transcript-row]',
    ),
  ).find(
    (candidate) => candidate.getBoundingClientRect().bottom >= viewportTop,
  );
  const rowKey = row?.dataset.transcriptKey ?? row?.dataset.transcriptRow;
  return row && rowKey
    ? {
        rowKey,
        rowOffset: row.getBoundingClientRect().top - viewportTop,
      }
    : {};
}
