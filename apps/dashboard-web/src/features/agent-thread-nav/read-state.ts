import type { AgentThreadRow } from './model';

export const AGENT_THREAD_READ_STATE_KEY = 'pi-dashboard-agent-thread-read-v1';

type ThreadReadRecord = {
  visited: boolean;
  visitedAt?: number;
  manuallyUnread?: boolean;
};

export type ThreadReadState = Record<string, ThreadReadRecord>;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readThreadReadState(): ThreadReadState {
  try {
    const raw = storage()?.getItem(AGENT_THREAD_READ_STATE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    const result: ThreadReadState = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      result[id] = {
        visited: record.visited === true,
        visitedAt:
          typeof record.visitedAt === 'number' ? record.visitedAt : undefined,
        manuallyUnread: record.manuallyUnread === true ? true : undefined,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function writeThreadReadState(state: ThreadReadState): void {
  try {
    storage()?.setItem(AGENT_THREAD_READ_STATE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing and storage quota failures should not affect navigation.
  }
}

export function isThreadUnread(
  row: Pick<AgentThreadRow, 'id' | 'updatedAt'>,
  state: ThreadReadState,
): boolean {
  const record = state[row.id];
  if (!record) return false;
  if (record.manuallyUnread) return true;
  return (
    record.visited &&
    row.updatedAt !== undefined &&
    (record.visitedAt === undefined || row.updatedAt > record.visitedAt)
  );
}

export function visitThread(
  state: ThreadReadState,
  id: string,
  updatedAt?: number,
): ThreadReadState {
  return {
    ...state,
    [id]: { visited: true, visitedAt: updatedAt },
  };
}

export function markThreadUnread(
  state: ThreadReadState,
  id: string,
): ThreadReadState {
  return {
    ...state,
    [id]: {
      visited: state[id]?.visited ?? false,
      visitedAt: state[id]?.visitedAt,
      manuallyUnread: true,
    },
  };
}
