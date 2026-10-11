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

export type QueueHandoffStatus =
  | 'handing-off'
  | 'accepted'
  | 'entered'
  | 'failed'
  | 'uncertain';

export type QueuedMessage = {
  id: string;
  mode: 'steer' | 'followUp';
  text: string;
  imageCount?: number;
  revision?: number;
  status?: QueueHandoffStatus;
  detail?: string;
};

export function queuedMessagesForRuntime(
  runtime: RuntimeSnapshot | undefined,
): readonly QueuedMessage[] {
  const drafts = Array.isArray(runtime?.queueDrafts) ? runtime.queueDrafts : [];
  const handoffs = Array.isArray(runtime?.queueHandoffs)
    ? runtime.queueHandoffs
    : [];
  const byId = new Map<string, QueuedMessage>();
  const add = (
    item: {
      clientId: string;
      mode: 'steer' | 'followUp';
      text: string;
      revision?: number;
      imageCount?: number;
      detail?: string;
    },
    status?: QueueHandoffStatus,
    detail?: string,
  ) => {
    if (!item.clientId || typeof item.text !== 'string') return;
    const next: QueuedMessage = {
      id: item.clientId,
      mode: item.mode,
      text: item.text,
      ...(item.imageCount ? { imageCount: item.imageCount } : {}),
      ...(typeof item.revision === 'number' ? { revision: item.revision } : {}),
      ...(status
        ? {
            status,
            ...((detail ?? item.detail)
              ? { detail: detail ?? item.detail }
              : {}),
          }
        : {}),
    };
    const previous = byId.get(item.clientId);
    if ((previous?.revision ?? 0) > (next.revision ?? 0)) return;
    byId.set(item.clientId, next);
  };
  const seenDraftIds = new Set<string>();
  for (const item of drafts) {
    if (
      item &&
      typeof item.clientId === 'string' &&
      (item.mode === 'steer' || item.mode === 'followUp') &&
      typeof item.text === 'string' &&
      !seenDraftIds.has(item.clientId)
    ) {
      seenDraftIds.add(item.clientId);
      const handoff = handoffs.find(
        (candidate) =>
          candidate.clientId === item.clientId &&
          candidate.revision === item.revision,
      );
      if (handoff?.status !== 'entered')
        add(item, handoff?.status, handoff?.detail);
    }
  }
  for (const handoff of handoffs) {
    if (
      handoff.status !== 'entered' &&
      handoff.status !== 'failed' &&
      (handoff.mode === 'steer' || handoff.mode === 'followUp')
    )
      add(handoff, handoff.status);
  }
  return [...byId.values()];
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
  const handoffsKey = JSON.stringify(runtime?.queueHandoffs ?? []);
  const serverQueueKey = JSON.stringify([serverQueue, handoffsKey]);
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
    const handoffIds = new Set(
      (runtime?.queueHandoffs ?? []).map((handoff) => handoff.clientId),
    );
    for (const id of awaitingRef.current.keys())
      if (serverQueue.some((item) => item.id === id) || handoffIds.has(id))
        awaitingRef.current.delete(id);
    setQueue(
      mergeQueuedMessages(serverQueue, [...awaitingRef.current.values()]),
    );
  }, [
    runtime?.queueHandoffs,
    runtimeKey,
    serverQueue,
    serverQueueKey,
    serverQueueKnown,
  ]);

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

export function QueueModeIcon({ mode }: { mode: QueuedMessage['mode'] }) {
  return mode === 'steer' ? (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
    >
      <path
        d="M2 8h10M8 3l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
    >
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.5V8l2.5 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function QueueStatusIcon({
  status,
}: {
  status: QueueHandoffStatus | undefined;
}) {
  if (status === 'failed' || status === 'uncertain')
    return <span aria-hidden="true">!</span>;
  if (status === 'entered') return <span aria-hidden="true">✓</span>;
  if (status === 'accepted' || status === 'handing-off')
    return <span aria-hidden="true">·</span>;
  return <span aria-hidden="true">◷</span>;
}

function ActionIcon({ kind }: { kind: 'save' | 'edit' | 'remove' }) {
  const paths = {
    save: <path d="M3 2.75h8l2 2v8.5H3zM5 2.75v4h6v-4M5 13.25V9h6v4.25" />,
    edit: <path d="m3 11.5-.5 2 2-.5 8-8-1.5-1.5zM10 4l1.5 1.5" />,
    remove: <path d="M3 4.5h10M6 4.5v-2h4v2m-5 0 .5 9h5l.5-9m-4 2v5m2-5v5" />,
  }[kind];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths}
    </svg>
  );
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
  const locked = (item: QueuedMessage) =>
    item.status === 'handing-off' ||
    item.status === 'accepted' ||
    item.status === 'entered' ||
    item.status === 'uncertain';
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
      <div className={styles.list}>
        {items.map((item) => {
          const editing = editingId === item.id;
          const itemLocked = locked(item);
          const modeName = item.mode === 'steer' ? 'steer' : 'follow-up';
          const statusLabel = item.status
            ? {
                'handing-off': 'Sending to Pi',
                accepted: 'Accepted by Pi, not confirmed applied',
                entered: 'Entered the session',
                failed: 'Could not send',
                uncertain: 'Send outcome unknown',
              }[item.status]
            : 'Waiting in queue';
          return (
            <fieldset
              className={styles.item}
              key={item.id}
              aria-label={`Queued ${modeName} message: ${item.text}`}
            >
              <span
                className={`queue-${item.mode} ${styles.mode}`}
                title={
                  item.mode === 'steer' ? 'Steer current work' : 'Send later'
                }
                role="img"
                aria-label={
                  item.mode === 'steer' ? 'Steer current work' : 'Send later'
                }
              >
                <QueueModeIcon mode={item.mode} />
              </span>
              {editing ? (
                <input
                  aria-label={`Edit queued ${modeName} message`}
                  value={editingText}
                  onChange={(event) => setEditingText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void save(item);
                    }
                    if (event.key === 'Escape') setEditingId(undefined);
                  }}
                  disabled={mutation.isPending || itemLocked}
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
                  {item.detail ? (
                    <small className={styles.detail}>{item.detail}</small>
                  ) : null}
                </span>
              )}
              <span
                className={`${styles.status} ${item.status === 'failed' || item.status === 'uncertain' ? styles.statusError : ''}`}
                title={statusLabel}
                role="img"
                aria-label={statusLabel}
              >
                <QueueStatusIcon status={item.status} />
              </span>
              <div className={styles.actions}>
                {editing ? (
                  <AriaButton
                    type="button"
                    aria-label={`Save queued ${modeName} message`}
                    data-tooltip="Save"
                    isDisabled={
                      itemLocked ||
                      mutation.isPending ||
                      (!editingText.trim() && !item.imageCount)
                    }
                    onPress={() => void save(item)}
                  >
                    <ActionIcon kind="save" />
                  </AriaButton>
                ) : (
                  <AriaButton
                    type="button"
                    aria-label={`Edit queued ${modeName} message`}
                    data-tooltip="Edit"
                    isDisabled={itemLocked || mutation.isPending}
                    onPress={() => beginEdit(item)}
                  >
                    <ActionIcon kind="edit" />
                  </AriaButton>
                )}
                <AriaButton
                  type="button"
                  className="queue-remove"
                  aria-label={`Remove queued ${modeName} message`}
                  data-tooltip="Remove"
                  isDisabled={itemLocked || mutation.isPending}
                  onPress={() => void remove(item)}
                >
                  <ActionIcon kind="remove" />
                </AriaButton>
              </div>
            </fieldset>
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
