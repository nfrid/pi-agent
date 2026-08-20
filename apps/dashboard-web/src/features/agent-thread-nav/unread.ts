import { useCallback, useRef, useState } from 'react';
import type { AgentThreadRow } from './model';
import {
  markThreadUnread,
  readThreadReadState,
  shouldRecordThreadVisit,
  type ThreadReadState,
  type ThreadVisitPair,
  visitThread,
  writeThreadReadState,
} from './read-state';

export {
  AGENT_THREAD_READ_STATE_KEY,
  isThreadUnread,
  markThreadUnread,
  readThreadReadState,
  shouldRecordThreadVisit,
  type ThreadReadState,
  type ThreadVisitPair,
  visitThread,
  writeThreadReadState,
} from './read-state';

export function useAgentThreadUnread(currentSessionId?: string) {
  const [state, setState] = useState<ThreadReadState>(readThreadReadState);
  const lastVisited = useRef<ThreadVisitPair | undefined>(undefined);
  const visit = useCallback((id: string, updatedAt?: number) => {
    setState((current) => {
      const next = visitThread(current, id, updatedAt);
      writeThreadReadState(next);
      return next;
    });
  }, []);
  const markUnread = useCallback((id: string, updatedAt?: number) => {
    setState((current) => {
      const next = markThreadUnread(current, id, updatedAt);
      writeThreadReadState(next);
      return next;
    });
  }, []);

  const visitCurrent = useCallback(
    (rows: readonly AgentThreadRow[]) => {
      if (!currentSessionId) return;
      const row = rows.find((item) => item.id === currentSessionId);
      if (!row) return;
      if (
        !shouldRecordThreadVisit(lastVisited.current, {
          id: row.id,
          updatedAt: row.updatedAt,
        })
      )
        return;
      lastVisited.current = { id: row.id, updatedAt: row.updatedAt };
      visit(row.id, row.updatedAt);
    },
    [currentSessionId, visit],
  );

  return { state, visit, visitCurrent, markUnread };
}
