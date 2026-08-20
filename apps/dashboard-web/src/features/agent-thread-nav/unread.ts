import { useCallback, useRef, useState } from 'react';
import type { AgentThreadRow } from './model';
import {
  markThreadUnread,
  readThreadReadState,
  type ThreadReadState,
  visitThread,
  writeThreadReadState,
} from './read-state';

export {
  AGENT_THREAD_READ_STATE_KEY,
  isThreadUnread,
  markThreadUnread,
  readThreadReadState,
  type ThreadReadState,
  visitThread,
  writeThreadReadState,
} from './read-state';

export function useAgentThreadUnread(currentSessionId?: string) {
  const [state, setState] = useState<ThreadReadState>(readThreadReadState);
  const lastVisitedId = useRef<string | undefined>(undefined);
  const visit = useCallback((id: string, updatedAt?: number) => {
    setState((current) => {
      const next = visitThread(current, id, updatedAt);
      writeThreadReadState(next);
      return next;
    });
  }, []);
  const markUnread = useCallback((id: string) => {
    setState((current) => {
      const next = markThreadUnread(current, id);
      writeThreadReadState(next);
      return next;
    });
  }, []);

  const visitCurrent = useCallback(
    (rows: readonly AgentThreadRow[]) => {
      if (!currentSessionId || lastVisitedId.current === currentSessionId)
        return;
      const row = rows.find((item) => item.id === currentSessionId);
      if (!row) return;
      lastVisitedId.current = currentSessionId;
      visit(row.id, row.updatedAt);
    },
    [currentSessionId, visit],
  );

  return { state, visit, visitCurrent, markUnread };
}
