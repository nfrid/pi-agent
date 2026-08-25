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
  readonly images: readonly QueueDraftImage[];
};

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

  setSession(sessionId: string | undefined): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.drafts.clear();
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  list(): readonly QueueDraft[] {
    return [...this.drafts.values()].map(publicDraft);
  }

  add(
    draft:
      | QueueDraftAddCommand
      | (QueueDraft & { images?: readonly BridgeImageAttachment[] }),
  ): QueueDraft {
    this.requireSession();
    const clientId = validQueueDraftClientId(draft.clientId);
    if (this.drafts.has(clientId))
      throw queueDraftError(
        'duplicate-queue-draft-client-id',
        'Queue draft client id already exists.',
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
    if (!current)
      throw queueDraftError(
        'unknown-queue-draft-client-id',
        'Queue draft client id is unknown.',
      );
    const next = {
      clientId,
      mode: draft.mode,
      text: validQueueDraftText(draft.text, current.images.length > 0),
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
    if (!draft)
      throw queueDraftError(
        'unknown-queue-draft-client-id',
        'Queue draft client id is unknown.',
      );
    this.drafts.delete(clientId);
    return publicDraft(draft);
  }

  /** Atomically claim drafts for one Pi delivery boundary. */
  take(mode: QueueDraftMode): StoredQueueDraft[] {
    this.requireSession();
    const claimed: StoredQueueDraft[] = [];
    for (const [clientId, draft] of this.drafts) {
      if (draft.mode !== mode) continue;
      claimed.push({ ...draft, images: [...draft.images] });
      this.drafts.delete(clientId);
    }
    return claimed;
  }

  /** Restore a failed delivery without replacing newer edits. */
  restore(drafts: readonly StoredQueueDraft[]): void {
    if (!this.sessionId) return;
    for (const draft of drafts)
      if (
        !this.drafts.has(draft.clientId) &&
        this.totalTextLength() + draft.text.length <= MAX_QUEUE_DRAFT_TOTAL_TEXT
      )
        this.drafts.set(draft.clientId, {
          ...draft,
          images: [...draft.images],
        });
  }

  clear(): void {
    this.drafts.clear();
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
