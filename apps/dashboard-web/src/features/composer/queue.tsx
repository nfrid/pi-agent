import {
  commandMutationOptions,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { errorMessage } from '../../shared/lib/error-message';
import styles from './queue.module.css';

export type QueuedMessage = {
  id: string;
  mode: 'steer' | 'followUp';
  text: string;
  imageCount?: number;
};

export function queuedMessagesForRuntime(
  runtime: RuntimeSnapshot | undefined,
): readonly QueuedMessage[] {
  const queue = runtime?.queueDrafts;
  if (!Array.isArray(queue)) return [];
  const seen = new Set<string>();
  return queue.flatMap((item) => {
    if (
      !item ||
      typeof item.clientId !== 'string' ||
      item.clientId.length === 0 ||
      (item.mode !== 'steer' && item.mode !== 'followUp') ||
      typeof item.text !== 'string' ||
      seen.has(item.clientId)
    )
      return [];
    seen.add(item.clientId);
    return [
      {
        id: item.clientId,
        mode: item.mode,
        text: item.text,
        ...(item.imageCount ? { imageCount: item.imageCount } : {}),
      },
    ];
  });
}

/** Add or replace a queue item without creating duplicate client IDs. */
export function upsertQueuedMessage(
  items: readonly QueuedMessage[],
  item: QueuedMessage,
): QueuedMessage[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((candidate, candidateIndex) =>
    candidateIndex === index ? item : candidate,
  );
}

/**
 * Merge a live server queue with rows awaiting live-event confirmation.
 * Server rows win by ID; optimistic rows survive a stale event but cannot
 * create duplicate UI rows when the runtime event arrives first.
 */
export function mergeQueuedMessages(
  serverItems: readonly QueuedMessage[],
  awaitingItems: readonly QueuedMessage[],
): QueuedMessage[] {
  const seen = new Set(serverItems.map((item) => item.id));
  return [
    ...serverItems,
    ...awaitingItems.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  ];
}

export function newQueueId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function queueCommand(
  type: 'queue.add' | 'queue.update',
  clientId: string,
  mode: 'steer' | 'followUp',
  text: string,
): Record<string, unknown> {
  return {
    id: newQueueId(),
    type,
    clientId,
    mode,
    text: text.trim(),
  };
}

export function queueRemoveCommand(clientId: string): Record<string, unknown> {
  return { id: newQueueId(), type: 'queue.remove', clientId };
}

export function shouldShowQueuePanel(
  liveState: RuntimeSnapshot['liveState'],
  queuedCount: number,
  settledBackground = false,
): boolean {
  return (
    queuedCount > 0 ||
    (!settledBackground &&
      (liveState === 'working' || liveState === 'compacting'))
  );
}

export function shouldQueueComposerMessage(
  liveState: RuntimeSnapshot['liveState'],
  mode: 'prompt' | 'steer' | 'followUp',
  _hasAttachments: boolean,
  settledBackground = false,
): boolean {
  if (settledBackground) return false;
  if (liveState === 'compacting') return true;
  return liveState === 'working' && mode !== 'followUp';
}

export function useComposerQueue(runtime: RuntimeSnapshot | undefined) {
  const serverQueue = queuedMessagesForRuntime(runtime);
  const serverQueueKnown = Array.isArray(runtime?.queueDrafts);
  const serverQueueKey = JSON.stringify(serverQueue);
  const runtimeKey = runtime
    ? `${runtime.runtimeId}:${runtime.session.id}`
    : undefined;
  const serverQueueKeyRef = useRef(serverQueueKey);
  const runtimeKeyRef = useRef(runtimeKey);
  const awaitingRef = useRef(new Map<string, QueuedMessage>());
  const serverQueueRef = useRef<readonly QueuedMessage[]>(serverQueue);
  const [queue, setQueue] = useState<QueuedMessage[]>(() => [...serverQueue]);

  useEffect(() => {
    const runtimeChanged = runtimeKeyRef.current !== runtimeKey;
    if (runtimeChanged) {
      // A command acknowledged by a replaced runtime belongs to the old
      // session. Do not leak it into the replacement composer.
      runtimeKeyRef.current = runtimeKey;
      awaitingRef.current.clear();
      serverQueueKeyRef.current = serverQueueKey;
      serverQueueRef.current = serverQueue;
      setQueue(serverQueueKnown ? [...serverQueue] : []);
      return;
    }
    if (!serverQueueKnown) return;
    serverQueueRef.current = serverQueue;
    if (serverQueueKeyRef.current === serverQueueKey) return;
    serverQueueKeyRef.current = serverQueueKey;
    for (const id of awaitingRef.current.keys())
      if (serverQueue.some((item) => item.id === id))
        awaitingRef.current.delete(id);
    setQueue(
      mergeQueuedMessages(serverQueue, [...awaitingRef.current.values()]),
    );
  }, [runtimeKey, serverQueue, serverQueueKey, serverQueueKnown]);

  const addOptimistic = useCallback((item: QueuedMessage) => {
    awaitingRef.current.set(item.id, item);
    setQueue((current) => upsertQueuedMessage(current, item));
  }, []);
  const rejectOptimistic = useCallback((id: string) => {
    awaitingRef.current.delete(id);
    setQueue(
      mergeQueuedMessages(serverQueueRef.current, [
        ...awaitingRef.current.values(),
      ]),
    );
  }, []);
  const updateQueue = useCallback((next: SetStateAction<QueuedMessage[]>) => {
    setQueue((current) => {
      const updated = typeof next === 'function' ? next(current) : next;
      for (const id of awaitingRef.current.keys())
        if (!updated.some((item) => item.id === id))
          awaitingRef.current.delete(id);
      return updated;
    });
  }, []);

  return {
    queue,
    setQueue: updateQueue,
    addOptimistic,
    rejectOptimistic,
  };
}

export function QueuePanel({
  runtimeId,
  items,
  onItemsChange,
}: {
  runtimeId: string;
  items: readonly QueuedMessage[];
  onItemsChange: Dispatch<SetStateAction<QueuedMessage[]>>;
}) {
  const mutation = useMutation(commandMutationOptions(dashboardHttpClient));
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState('');
  const [error, setError] = useState<string>();
  const beginEdit = (item: QueuedMessage) => {
    setEditingId(item.id);
    setEditingText(item.text);
    setError(undefined);
  };
  const save = async (item: QueuedMessage) => {
    const text = editingText.trim();
    if ((!text && !item.imageCount) || mutation.isPending) return;
    setError(undefined);
    try {
      await mutation.mutateAsync({
        runtimeId,
        command: queueCommand('queue.update', item.id, item.mode, text),
      });
      onItemsChange((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? { ...candidate, text } : candidate,
        ),
      );
      setEditingId(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const remove = async (item: QueuedMessage) => {
    if (mutation.isPending) return;
    setError(undefined);
    try {
      await mutation.mutateAsync({
        runtimeId,
        command: queueRemoveCommand(item.id),
      });
      onItemsChange((current) =>
        current.filter((candidate) => candidate.id !== item.id),
      );
      if (editingId === item.id) setEditingId(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  if (!items.length) return null;
  return (
    <section
      className={`queue-panel ${styles.panel}`}
      aria-label="Queued messages"
    >
      <div className={styles.heading}>
        <span className="eyebrow">Queue</span>
        <span>{items.length} waiting</span>
      </div>
      <div className={styles.list}>
        {items.map((item) => {
          const editing = editingId === item.id;
          return (
            <div className={styles.item} key={item.id}>
              <span className={`queue-${item.mode} ${styles.mode}`}>
                {item.mode === 'steer' ? 'steer' : 'follow-up'}
              </span>
              {editing ? (
                <input
                  aria-label={`Edit queued ${item.mode} message`}
                  value={editingText}
                  onChange={(event) => setEditingText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void save(item);
                    }
                    if (event.key === 'Escape') setEditingId(undefined);
                  }}
                  disabled={mutation.isPending}
                />
              ) : (
                <span className={styles.text}>
                  {item.text}
                  {item.imageCount ? (
                    <small>
                      {item.imageCount} image
                      {item.imageCount === 1 ? '' : 's'} attached
                    </small>
                  ) : null}
                </span>
              )}
              <div className={styles.actions}>
                {editing ? (
                  <AriaButton
                    type="button"
                    isDisabled={
                      mutation.isPending ||
                      (!editingText.trim() && !item.imageCount)
                    }
                    onPress={() => void save(item)}
                  >
                    Save
                  </AriaButton>
                ) : (
                  <AriaButton
                    type="button"
                    isDisabled={mutation.isPending}
                    onPress={() => beginEdit(item)}
                  >
                    Edit
                  </AriaButton>
                )}
                <AriaButton
                  type="button"
                  className="queue-remove"
                  isDisabled={mutation.isPending}
                  onPress={() => void remove(item)}
                >
                  Remove
                </AriaButton>
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <p className={`error ${styles.error}`} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
