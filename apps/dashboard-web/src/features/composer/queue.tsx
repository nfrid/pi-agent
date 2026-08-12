import {
  commandMutationOptions,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import styles from './queue.module.css';

export type QueuedMessage = {
  id: string;
  mode: 'steer' | 'followUp';
  text: string;
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
    return [{ id: item.clientId, mode: item.mode, text: item.text }];
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
): boolean {
  return (
    liveState === 'working' || liveState === 'compacting' || queuedCount > 0
  );
}

export function useComposerQueue(runtime: RuntimeSnapshot | undefined) {
  const serverQueue = queuedMessagesForRuntime(runtime);
  const serverQueueKey = JSON.stringify(serverQueue);
  const serverQueueKeyRef = useRef(serverQueueKey);
  const [queue, setQueue] = useState<QueuedMessage[]>(() => [...serverQueue]);

  useEffect(() => {
    if (serverQueueKeyRef.current === serverQueueKey) return;
    serverQueueKeyRef.current = serverQueueKey;
    setQueue([...serverQueue]);
  }, [serverQueue, serverQueueKey]);

  return [queue, setQueue] as const;
}

export function QueuePanel({
  runtimeId,
  items,
  onItemsChange,
}: {
  runtimeId: string;
  items: readonly QueuedMessage[];
  onItemsChange: (items: QueuedMessage[]) => void;
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
    if (!text || mutation.isPending) return;
    setError(undefined);
    try {
      await mutation.mutateAsync({
        runtimeId,
        command: queueCommand('queue.update', item.id, item.mode, text),
      });
      onItemsChange(
        items.map((candidate) =>
          candidate.id === item.id ? { ...candidate, text } : candidate,
        ),
      );
      setEditingId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
      onItemsChange(items.filter((candidate) => candidate.id !== item.id));
      if (editingId === item.id) setEditingId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  if (!items.length) return null;
  return (
    <section
      className={`queue-panel ${styles.panel}`}
      aria-label="Queued messages"
    >
      <div className={`queue-heading ${styles.heading}`}>
        <span className="eyebrow">Queue</span>
        <span>{items.length} waiting</span>
      </div>
      <div className={`queue-list ${styles.list}`}>
        {items.map((item) => {
          const editing = editingId === item.id;
          return (
            <div className={`queue-item ${styles.item}`} key={item.id}>
              <span className={`queue-mode queue-${item.mode} ${styles.mode}`}>
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
                <span className={`queue-text ${styles.text}`}>{item.text}</span>
              )}
              <div className={`queue-actions ${styles.actions}`}>
                {editing ? (
                  <AriaButton
                    type="button"
                    isDisabled={mutation.isPending || !editingText.trim()}
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
        <p className={`error queue-error ${styles.error}`} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
