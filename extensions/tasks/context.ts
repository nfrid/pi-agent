import type {
  ContextEvent,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { unfinished } from './domain';
import { turnSnapshotText } from './format';
import {
  EXT,
  LEGACY_TODO_REPLAY_TYPE,
  LEGACY_TODO_SNAPSHOT_TYPE,
  TOOL,
} from './model';
import type { TaskStore } from './store';

export const TODO_RESULT_ELIDED = '[todo tool result elided]';
export const TODO_SNAPSHOT_TYPE = `${EXT}-turn-snapshot`;
export const EXACT_TODO_RESULT_PREFIX = 6;

export type TodoContextMessages = ContextEvent['messages'];

function isLegacyReplay(message: TodoContextMessages[number]): boolean {
  return (
    message.role === 'custom' && message.customType === LEGACY_TODO_REPLAY_TYPE
  );
}

function isTodoSnapshot(message: TodoContextMessages[number]): boolean {
  return (
    message.role === 'custom' &&
    (message.customType === TODO_SNAPSHOT_TYPE ||
      message.customType === LEGACY_TODO_SNAPSHOT_TYPE)
  );
}

function elidedResult(
  message: TodoContextMessages[number],
): TodoContextMessages[number] {
  if (message.role !== 'toolResult') return message;
  return {
    ...message,
    content: [{ type: 'text' as const, text: TODO_RESULT_ELIDED }],
  };
}

/** Append a persistent, immutable snapshot at the start of a user turn. */
export function appendTodoSnapshot(
  input: TodoContextMessages,
  snapshot: string,
  timestamp: number,
): TodoContextMessages {
  return [
    ...input,
    {
      role: 'custom',
      customType: TODO_SNAPSHOT_TYPE,
      content: snapshot,
      display: false,
      timestamp,
    },
  ];
}

/**
 * Build provider context from immutable turn-start snapshots. Every snapshot is
 * preserved byte-for-byte. The fixed first six todo results and all results
 * after the newest snapshot remain exact; intervening results are elided.
 *
 * Missing snapshots retain all exact evidence and append a current snapshot.
 * Compaction/tree recovery additionally appends a current trailing snapshot.
 * Legacy mutable replay messages are always removed.
 */
export function transformTodoContext(
  input: TodoContextMessages,
  snapshot: string,
  timestamp: number,
  forceRecovery = false,
): TodoContextMessages {
  let newestSnapshotIndex = -1;
  for (let index = 0; index < input.length; index++) {
    if (isTodoSnapshot(input[index])) newestSnapshotIndex = index;
  }

  if (newestSnapshotIndex < 0) {
    return appendTodoSnapshot(
      input.filter((message) => !isLegacyReplay(message)),
      snapshot,
      timestamp,
    );
  }

  let todoResultsSeen = 0;
  const transformed = input
    .map((message, index) => {
      if (isLegacyReplay(message)) return undefined;
      if (message.role !== 'toolResult' || message.toolName !== TOOL)
        return message;
      todoResultsSeen++;
      const afterNewestSnapshot = index > newestSnapshotIndex;
      return todoResultsSeen <= EXACT_TODO_RESULT_PREFIX || afterNewestSnapshot
        ? message
        : elidedResult(message);
    })
    .filter((message): message is TodoContextMessages[number] =>
      Boolean(message),
    );

  return forceRecovery
    ? appendTodoSnapshot(transformed, snapshot, timestamp)
    : transformed;
}

export function registerTodoContext(pi: ExtensionAPI, store: TaskStore): void {
  let needsRecovery = false;
  let hasTodoHistory = false;
  let persistedEmptySnapshot: string | undefined;

  const hasActiveTasks = () => store.state.tasks.some(unfinished);

  pi.on('session_start', () => {
    needsRecovery = false;
    hasTodoHistory = store.state.tasks.length > 0;
    persistedEmptySnapshot = undefined;
  });
  pi.on('session_compact', () => {
    needsRecovery = true;
  });
  pi.on('session_tree', () => {
    needsRecovery = true;
  });
  pi.on('before_agent_start', () => {
    const active = hasActiveTasks();
    const snapshot = turnSnapshotText(store);
    if (active) {
      hasTodoHistory = true;
      persistedEmptySnapshot = undefined;
      needsRecovery = false;
    } else if (!hasTodoHistory) {
      needsRecovery = false;
      return undefined;
    } else if (persistedEmptySnapshot !== snapshot) {
      // Persist one reset for each distinct inactive state, then reuse it.
      persistedEmptySnapshot = snapshot;
      needsRecovery = false;
    } else {
      // A matching reset is already in history. Let context handle recovery
      // if compaction/tree restoration requested it, but do not emit a new
      // byte-identical before-agent snapshot.
      return undefined;
    }
    return {
      message: {
        customType: TODO_SNAPSHOT_TYPE,
        content: snapshot,
        display: false,
      },
    };
  });
  pi.on('context', (event) => {
    const active = hasActiveTasks();
    if (active) {
      hasTodoHistory = true;
      persistedEmptySnapshot = undefined;
    }
    if (
      event.messages.some(
        (message) =>
          isTodoSnapshot(message) ||
          (message.role === 'toolResult' && message.toolName === TOOL),
      )
    )
      hasTodoHistory = true;
    if (!hasTodoHistory)
      return {
        messages: event.messages.filter((message) => !isLegacyReplay(message)),
      };

    // Once the list is cleared, old snapshots would otherwise keep stale tasks
    // visible. Keep the newest matching empty snapshot as the reset anchor so
    // unchanged empty turns do not append another byte-identical snapshot.
    const snapshot = turnSnapshotText(store);
    let newestSnapshotIndex = -1;
    let newestEmptySnapshotIndex = -1;
    for (let index = 0; index < event.messages.length; index++) {
      const message = event.messages[index];
      if (!isTodoSnapshot(message)) continue;
      newestSnapshotIndex = index;
      if (!active && message.role === 'custom' && message.content === snapshot)
        newestEmptySnapshotIndex = index;
    }
    if (
      !active &&
      newestEmptySnapshotIndex === newestSnapshotIndex &&
      newestEmptySnapshotIndex >= 0
    )
      persistedEmptySnapshot = snapshot;
    const input = active
      ? event.messages
      : event.messages.filter(
          (message, index) =>
            !isTodoSnapshot(message) ||
            (index === newestEmptySnapshotIndex &&
              newestEmptySnapshotIndex === newestSnapshotIndex),
        );
    const messages = transformTodoContext(
      input,
      snapshot,
      Date.now(),
      needsRecovery,
    );
    // Recovery is a one-shot provider-context repair. A before-agent snapshot
    // has already handled it when one was emitted.
    needsRecovery = false;
    return { messages };
  });
}
