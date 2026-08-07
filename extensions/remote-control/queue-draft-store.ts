import {
  type BridgeCommand,
  MAX_QUEUE_DRAFT_TEXT,
  MAX_QUEUE_DRAFT_TOTAL_TEXT,
  MAX_QUEUE_DRAFTS,
  type QueueDraft,
  type QueueDraftAddCommand,
  type QueueDraftMode,
  type QueueDraftRemoveCommand,
  type QueueDraftUpdateCommand,
} from '../../packages/dashboard-protocol/src/pi-runtime-protocol';

export function queueDraftError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function validQueueDraftText(text: string): string {
  const normalized = text.trim();
  if (!normalized || normalized.length > MAX_QUEUE_DRAFT_TEXT)
    throw queueDraftError(
      'invalid-queue-draft',
      'Queue draft text is invalid.',
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

/**
 * Dashboard-owned queue state. Pi's own queue is intentionally not reflected
 * here: drafts remain editable until a lifecycle boundary hands them to Pi.
 */
export class QueueDraftStore {
  private sessionId: string | undefined;
  private readonly drafts = new Map<string, QueueDraft>();

  setSession(sessionId: string | undefined): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.drafts.clear();
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  list(): readonly QueueDraft[] {
    return [...this.drafts.values()].map((draft) => ({ ...draft }));
  }

  add(draft: QueueDraft): QueueDraft {
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
    const next = {
      clientId,
      mode: draft.mode,
      text: validQueueDraftText(draft.text),
    } satisfies QueueDraft;
    if (this.totalTextLength() + next.text.length > MAX_QUEUE_DRAFT_TOTAL_TEXT)
      throw queueDraftError(
        'queue-draft-capacity',
        'Queue draft text capacity is full.',
      );
    this.drafts.set(clientId, next);
    return { ...next };
  }

  update(draft: QueueDraft): QueueDraft {
    this.requireSession();
    const clientId = validQueueDraftClientId(draft.clientId);
    if (!this.drafts.has(clientId))
      throw queueDraftError(
        'unknown-queue-draft-client-id',
        'Queue draft client id is unknown.',
      );
    const next = {
      clientId,
      mode: draft.mode,
      text: validQueueDraftText(draft.text),
    } satisfies QueueDraft;
    const current = this.drafts.get(clientId);
    if (
      this.totalTextLength() - (current?.text.length ?? 0) + next.text.length >
      MAX_QUEUE_DRAFT_TOTAL_TEXT
    )
      throw queueDraftError(
        'queue-draft-capacity',
        'Queue draft text capacity is full.',
      );
    this.drafts.set(clientId, next);
    return { ...next };
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
    return { ...draft };
  }

  /** Atomically claim drafts for one Pi delivery boundary. */
  take(mode: QueueDraftMode): QueueDraft[] {
    this.requireSession();
    const claimed: QueueDraft[] = [];
    for (const [clientId, draft] of this.drafts) {
      if (draft.mode !== mode) continue;
      claimed.push({ ...draft });
      this.drafts.delete(clientId);
    }
    return claimed;
  }

  /** Restore a failed delivery without replacing newer edits. */
  restore(drafts: readonly QueueDraft[]): void {
    if (!this.sessionId) return;
    for (const draft of drafts)
      if (
        !this.drafts.has(draft.clientId) &&
        this.totalTextLength() + draft.text.length <= MAX_QUEUE_DRAFT_TOTAL_TEXT
      )
        this.drafts.set(draft.clientId, { ...draft });
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
