import { readFileSync, statSync } from 'node:fs';
import {
  type BridgeCommand,
  type BridgeImageAttachment,
  MAX_QUEUE_DRAFT_TEXT,
  MAX_QUEUE_DRAFT_TOTAL_TEXT,
  MAX_QUEUE_DRAFTS,
  type QueueDraft,
  type QueueDraftAddCommand,
  type QueueDraftMode,
  type QueueDraftRemoveCommand,
  type QueueDraftUpdateCommand,
  type QueueHandoff,
} from '@pi-dashboard/protocol/pi-runtime-protocol';

export function queueDraftError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function validQueueDraftText(text: string, hasImages = false): string {
  const normalized = text.trim();
  if ((!normalized && !hasImages) || normalized.length > MAX_QUEUE_DRAFT_TEXT)
    throw queueDraftError(
      'invalid-queue-draft',
      'Queue draft text or image is invalid.',
    );
  return normalized;
}

function validQueueDraftClientId(clientId: string): string {
  if (
    !clientId.trim() ||
    clientId.length > 256 ||
    [...clientId].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw queueDraftError(
      'invalid-queue-draft-client-id',
      'Queue draft client id is invalid.',
    );
  return clientId;
}

export type QueueDraftImage = {
  type: 'image';
  data: string;
  mimeType: BridgeImageAttachment['mediaType'];
};

export type StoredQueueDraft = QueueDraft & {
  readonly revision: number;
  readonly images: readonly QueueDraftImage[];
};
type QueueHandoffRecord = QueueHandoff;
const handoffKey = (clientId: string, revision: number) =>
  `${clientId}:${revision}`;

function ownImages(
  images: readonly BridgeImageAttachment[] | undefined,
): QueueDraftImage[] {
  return (images ?? []).map((image) => {
    const stat = statSync(image.path);
    if (!stat.isFile() || stat.size === 0 || stat.size > 5 * 1024 * 1024)
      throw queueDraftError(
        'invalid-queue-draft-image',
        'Queued image attachment is invalid.',
      );
    return {
      type: 'image',
      data: readFileSync(image.path).toString('base64'),
      mimeType: image.mediaType,
    };
  });
}

function publicDraft(draft: StoredQueueDraft): QueueDraft {
  const { images, ...metadata } = draft;
  return {
    ...metadata,
    ...(images.length > 0 ? { imageCount: images.length } : {}),
  };
}

/**
 * Dashboard-owned queue state. Pi's own queue is intentionally not reflected
 * here: drafts remain editable until a lifecycle boundary hands them to Pi.
 * Image bytes are copied into this runtime-private store before HTTP upload
 * cleanup and never appear in bridge snapshots.
 */
export class QueueDraftStore {
  private sessionId: string | undefined;
  private readonly drafts = new Map<string, StoredQueueDraft>();
  private readonly handoffs = new Map<string, QueueHandoffRecord>();

  setSession(sessionId: string | undefined): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.drafts.clear();
    this.handoffs.clear();
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  list(): readonly QueueDraft[] {
    return [...this.drafts.values()]
      .filter((draft) => {
        const status = this.handoffs.get(
          handoffKey(draft.clientId, draft.revision),
        )?.status;
        return (
          status !== 'handing-off' &&
          status !== 'accepted' &&
          status !== 'entered'
        );
      })
      .map(publicDraft);
  }

  add(
    draft:
      | QueueDraftAddCommand
      | (QueueDraft & { images?: readonly BridgeImageAttachment[] }),
  ): QueueDraft {
    this.requireSession();
    const clientId = validQueueDraftClientId(draft.clientId);
    if (
      this.drafts.has(clientId) ||
      [...this.handoffs.values()].some(
        (handoff) => handoff.clientId === clientId,
      )
    )
      throw queueDraftError(
        'duplicate-queue-draft-client-id',
        'Queue draft client id already exists or was already handed off.',
      );
    if (this.drafts.size >= MAX_QUEUE_DRAFTS)
      throw queueDraftError(
        'queue-draft-capacity',
        'Queue draft queue is full.',
      );
    const images = ownImages(draft.images);
    const next = {
      clientId,
      mode: draft.mode,
      text: validQueueDraftText(draft.text, images.length > 0),
      revision: 1,
      images,
    } satisfies StoredQueueDraft;
    if (this.totalTextLength() + next.text.length > MAX_QUEUE_DRAFT_TOTAL_TEXT)
      throw queueDraftError(
        'queue-draft-capacity',
        'Queue draft text capacity is full.',
      );
    this.drafts.set(clientId, next);
    return publicDraft(next);
  }

  update(draft: QueueDraftUpdateCommand | QueueDraft): QueueDraft {
    this.requireSession();
    const clientId = validQueueDraftClientId(draft.clientId);
    const current = this.drafts.get(clientId);
    if (!current) {
      const handedOff = [...this.handoffs.values()].some(
        (handoff) =>
          handoff.clientId === clientId &&
          ['handing-off', 'accepted', 'entered', 'uncertain'].includes(
            handoff.status,
          ),
      );
      if (handedOff)
        throw queueDraftError(
          'queue-handoff-outcome-unknown',
          'An accepted or uncertain queue item cannot be edited safely.',
        );
      throw queueDraftError(
        'unknown-queue-draft-client-id',
        'Queue draft client id is unknown.',
      );
    }
    const handoff = this.handoffs.get(handoffKey(clientId, current.revision));
    if (
      handoff?.status === 'handing-off' ||
      handoff?.status === 'accepted' ||
      handoff?.status === 'entered' ||
      handoff?.status === 'uncertain'
    )
      throw queueDraftError(
        'queue-handoff-outcome-unknown',
        'An accepted or uncertain queue item cannot be edited safely.',
      );
    const next = {
      clientId,
      mode: draft.mode,
      text: validQueueDraftText(draft.text, current.images.length > 0),
      revision: current.revision + 1,
      images: current.images,
    } satisfies StoredQueueDraft;
    if (
      this.totalTextLength() - current.text.length + next.text.length >
      MAX_QUEUE_DRAFT_TOTAL_TEXT
    )
      throw queueDraftError(
        'queue-draft-capacity',
        'Queue draft text capacity is full.',
      );
    this.drafts.set(clientId, next);
    return publicDraft(next);
  }

  remove(clientId: string): QueueDraft {
    this.requireSession();
    validQueueDraftClientId(clientId);
    const draft = this.drafts.get(clientId);
    if (!draft) {
      const handedOff = [...this.handoffs.values()].some(
        (handoff) =>
          handoff.clientId === clientId &&
          ['handing-off', 'accepted', 'entered', 'uncertain'].includes(
            handoff.status,
          ),
      );
      if (handedOff)
        throw queueDraftError(
          'queue-handoff-in-progress',
          'A handed-off queue item cannot be cancelled until its outcome is known.',
        );
      throw queueDraftError(
        'unknown-queue-draft-client-id',
        'Queue draft client id is unknown.',
      );
    }
    if (
      ['handing-off', 'accepted', 'entered', 'uncertain'].includes(
        this.handoffs.get(handoffKey(clientId, draft.revision))?.status ?? '',
      )
    )
      throw queueDraftError(
        'queue-handoff-in-progress',
        'A handed-off queue item cannot be cancelled until its outcome is known.',
      );
    this.drafts.delete(clientId);
    this.handoffs.delete(handoffKey(clientId, draft.revision));
    return publicDraft(draft);
  }

  /** Atomically claim the exact FIFO head for native steering. */
  claimSteerNow(
    clientId: string,
    revision: number,
  ): StoredQueueDraft | undefined {
    this.requireSession();
    const first = [...this.drafts.values()].find(
      (draft) => draft.mode === 'steer',
    );
    if (
      !first ||
      first.clientId !== clientId ||
      first.revision !== revision ||
      first.mode !== 'steer' ||
      first.images.length > 0
    )
      return undefined;
    const key = handoffKey(clientId, revision);
    const previous = this.handoffs.get(key);
    if (
      (previous && previous.status !== 'failed') ||
      (this.handoffs.size >= MAX_QUEUE_DRAFTS && !this.makeHandoffCapacity())
    )
      return undefined;
    const copy = { ...first, images: [...first.images] };
    this.handoffs.set(key, {
      clientId,
      mode: first.mode,
      text: first.text,
      revision: first.revision,
      status: 'handing-off',
    });
    return copy;
  }

  /** Claim current revisions without removing editable state during async admission. */
  take(mode: QueueDraftMode): StoredQueueDraft[] {
    this.requireSession();
    const claimed: StoredQueueDraft[] = [];
    for (const [clientId, draft] of this.drafts) {
      const key = handoffKey(clientId, draft.revision);
      const previous = this.handoffs.get(key);
      if (
        draft.mode !== mode ||
        (previous && previous.status !== 'failed') ||
        !this.makeHandoffCapacity()
      )
        continue;
      const copy = { ...draft, images: [...draft.images] };
      claimed.push(copy);
      this.handoffs.set(key, {
        clientId,
        mode: draft.mode,
        text: draft.text,
        ...(draft.imageCount ? { imageCount: draft.imageCount } : {}),
        revision: draft.revision,
        status: 'handing-off',
      });
      break;
    }
    return claimed;
  }

  listHandoffs(): readonly QueueHandoff[] {
    return [...this.handoffs.values()];
  }

  resolveHandoff(
    draft: StoredQueueDraft,
    status: 'accepted' | 'entered' | 'failed' | 'uncertain',
    detail?: string,
  ): void {
    const key = handoffKey(draft.clientId, draft.revision);
    const current = this.handoffs.get(key);
    if (!current) return;
    if (
      (status === 'accepted' || status === 'entered') &&
      this.drafts.get(draft.clientId)?.revision === draft.revision
    )
      this.drafts.delete(draft.clientId);
    if (current.status === 'entered') return;
    this.handoffs.set(key, {
      ...current,
      status,
      ...(detail ? { detail: detail.slice(0, 2000) } : {}),
    });
    this.trimHandoffs();
  }

  releaseHandoff(draft: StoredQueueDraft): void {
    this.handoffs.delete(handoffKey(draft.clientId, draft.revision));
  }

  clear(): void {
    this.drafts.clear();
    this.handoffs.clear();
  }

  private trimHandoffs(): void {
    while (this.handoffs.size > MAX_QUEUE_DRAFTS) {
      const evictable = [...this.handoffs].find(
        ([, handoff]) =>
          handoff.status === 'entered' || handoff.status === 'failed',
      );
      if (!evictable) return;
      this.handoffs.delete(evictable[0]);
    }
  }

  private makeHandoffCapacity(): boolean {
    if (this.handoffs.size < MAX_QUEUE_DRAFTS) return true;
    const evictable = [...this.handoffs].find(
      ([, handoff]) =>
        handoff.status === 'entered' || handoff.status === 'failed',
    );
    if (!evictable) return false;
    this.handoffs.delete(evictable[0]);
    return true;
  }

  private totalTextLength(): number {
    let total = 0;
    for (const draft of this.drafts.values()) total += draft.text.length;
    return total;
  }

  private requireSession(): void {
    if (!this.sessionId)
      throw queueDraftError('session-unavailable', 'Pi session is not ready.');
  }
}

export function isQueueDraftCommand(
  command: BridgeCommand,
): command is
  | QueueDraftAddCommand
  | QueueDraftUpdateCommand
  | QueueDraftRemoveCommand {
  return (
    command.type === 'queue.add' ||
    command.type === 'queueDraft.add' ||
    command.type === 'queue.update' ||
    command.type === 'queueDraft.update' ||
    command.type === 'queue.remove' ||
    command.type === 'queueDraft.remove'
  );
}
