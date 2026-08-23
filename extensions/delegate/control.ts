import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Keep parent steering bounded and make control files disposable. */
export const MAX_DELEGATE_CONTROL_MESSAGE_BYTES = 4 * 1024;
export const MAX_DELEGATE_CONTROL_FILE_BYTES = 64 * 1024;
export const MAX_DELEGATE_CONTROL_REQUESTS = 32;
export const DELEGATE_CONTROL_MESSAGE_TYPE = 'delegate-control';
export const DELEGATE_CONTROL_POLL_MS = 100;

export type DelegateControlKind =
  | 'feedback'
  | 'checkpoint'
  | 'pause'
  | 'resume';

export interface DelegateControlRequest {
  id: string;
  kind: DelegateControlKind;
  message?: string;
  generation?: number;
  createdAt: number;
}

export interface DelegateControlEnqueueResult {
  accepted: boolean;
  id?: string;
  reason?: string;
}

export type DelegateControlLifecycleEvent =
  | { type: 'open'; channel: DelegateControlChannel }
  | { type: 'bind'; participantId: string; statusId: string }
  | {
      type: 'ack';
      participantId: string;
      kind: 'pause';
      generation: number;
    }
  | {
      type: 'close' | 'detach';
      participantId: string;
      ownerSessionId?: string;
      statusId?: string;
    };

export interface DelegateControlChannel {
  readonly participantId: string;
  readonly filePath: string;
  readonly ownerSessionId?: string;
  readonly runKind?: 'foreground' | 'background';
  bindStatusId: (statusId: string) => void;
  statusId: () => string | undefined;
  enqueue: (
    kind: 'feedback' | 'checkpoint',
    message: string,
  ) => DelegateControlEnqueueResult;
  pause: (generation: number) => DelegateControlEnqueueResult;
  resume: (generation: number) => DelegateControlEnqueueResult;
  acknowledge: (
    id: string,
    kind: DelegateControlKind,
    generation?: number,
  ) => void;
  /** Stop parent ownership while leaving the child inbox available. */
  detach: () => void;
  /** Close parent ownership and unlink the private inbox. */
  close: () => void;
}

let channelCounter = 0;
const activeChannels = new Map<string, DelegateControlChannel>();
const lifecycleListeners = new Set<
  (event: DelegateControlLifecycleEvent) => void
>();

export function listActiveDelegateControlChannels(): DelegateControlChannel[] {
  return [...activeChannels.values()];
}

export function subscribeDelegateControlLifecycle(
  listener: (event: DelegateControlLifecycleEvent) => void,
): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

function emitLifecycle(event: DelegateControlLifecycleEvent): void {
  for (const listener of lifecycleListeners) listener(event);
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isCanonicalUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function controlPath(sessionPath: string, processJobId?: string): string {
  if (processJobId !== undefined) {
    if (!path.isAbsolute(sessionPath) || !isCanonicalUuid(processJobId))
      throw new Error('Hosted delegate control path inputs are invalid.');
    return `${path.resolve(sessionPath)}.${processJobId}.control`;
  }
  return `${sessionPath}.${process.pid}.${++channelCounter}.control`;
}

/** Parent side of a private child control inbox. */
export function createDelegateControlChannel(
  sessionPath: string,
  ownerSessionId?: string,
  runKind?: 'foreground' | 'background',
  processJobId?: string,
): DelegateControlChannel {
  const filePath = controlPath(sessionPath, processJobId);
  const participantId = filePath;
  let closed = false;
  let boundStatusId: string | undefined;
  let sequence = 0;
  const outstanding = new Map<string, boolean>();
  let boundedOutstandingCount = 0;

  const request = (
    input: Omit<DelegateControlRequest, 'id' | 'createdAt'>,
  ): DelegateControlRequest => ({
    id: `${process.pid}-${Date.now()}-${++sequence}`,
    ...input,
    createdAt: Date.now(),
  });

  const append = (
    value: DelegateControlRequest,
    options: { bypassLimits?: boolean } = {},
  ): DelegateControlEnqueueResult => {
    if (closed) return { accepted: false, reason: 'channel-closed' };
    if (
      !options.bypassLimits &&
      boundedOutstandingCount >= MAX_DELEGATE_CONTROL_REQUESTS
    )
      return { accepted: false, reason: 'queue-full' };
    const line = `${JSON.stringify(value)}\n`;
    try {
      const currentBytes = existsSync(filePath) ? statSync(filePath).size : 0;
      if (
        !options.bypassLimits &&
        currentBytes + bytes(line) > MAX_DELEGATE_CONTROL_FILE_BYTES
      )
        return { accepted: false, reason: 'queue-full' };
      appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
      try {
        chmodSync(filePath, 0o600);
      } catch {
        // The append succeeded; avoid a duplicate retry after a chmod failure.
      }
      const bounded = !options.bypassLimits;
      outstanding.set(value.id, bounded);
      if (bounded) boundedOutstandingCount++;
      return { accepted: true, id: value.id };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const channel: DelegateControlChannel = {
    participantId,
    filePath,
    ownerSessionId,
    runKind,
    bindStatusId(statusId) {
      boundStatusId = statusId;
      emitLifecycle({ type: 'bind', participantId, statusId });
    },
    statusId() {
      return boundStatusId;
    },
    enqueue(kind, message) {
      const text = message.trim();
      if (!text) return { accepted: false, reason: 'empty-message' };
      if (bytes(text) > MAX_DELEGATE_CONTROL_MESSAGE_BYTES)
        return { accepted: false, reason: 'message-too-large' };
      return append(request({ kind, message: text }));
    },
    pause(generation) {
      // One small pause record may exceed feedback bounds; resume compacts it.
      return append(request({ kind: 'pause', generation }), {
        bypassLimits: true,
      });
    },
    resume(generation) {
      // Resume is control-plane traffic and always has reserved capacity.
      return append(request({ kind: 'resume', generation }), {
        bypassLimits: true,
      });
    },
    acknowledge(id, kind, generation) {
      const bounded = outstanding.get(id);
      if (bounded !== undefined) {
        outstanding.delete(id);
        if (bounded) boundedOutstandingCount--;
        if (outstanding.size === 0) {
          try {
            writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 });
          } catch {
            // Compaction is opportunistic; queue accounting is authoritative.
          }
        }
      }
      if (kind === 'pause' && typeof generation === 'number')
        emitLifecycle({ type: 'ack', participantId, kind, generation });
    },
    detach() {
      if (closed) return;
      closed = true;
      activeChannels.delete(participantId);
      emitLifecycle({
        type: 'detach',
        participantId,
        ...(ownerSessionId ? { ownerSessionId } : {}),
        ...(boundStatusId ? { statusId: boundStatusId } : {}),
      });
    },
    close() {
      if (closed) return;
      closed = true;
      activeChannels.delete(participantId);
      emitLifecycle({
        type: 'close',
        participantId,
        ...(ownerSessionId ? { ownerSessionId } : {}),
        ...(boundStatusId ? { statusId: boundStatusId } : {}),
      });
      try {
        unlinkSync(filePath);
      } catch {
        // The child may already have removed or never created the inbox.
      }
    },
  };
  activeChannels.set(participantId, channel);
  emitLifecycle({ type: 'open', channel });
  return channel;
}

function isControlRequest(value: unknown): value is DelegateControlRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<DelegateControlRequest>;
  if (
    typeof request.id !== 'string' ||
    typeof request.createdAt !== 'number' ||
    !['feedback', 'checkpoint', 'pause', 'resume'].includes(request.kind ?? '')
  )
    return false;
  if (request.kind === 'pause' || request.kind === 'resume')
    return (
      typeof request.generation === 'number' &&
      Number.isSafeInteger(request.generation) &&
      request.generation > 0
    );
  return (
    typeof request.message === 'string' &&
    bytes(request.message) <= MAX_DELEGATE_CONTROL_MESSAGE_BYTES
  );
}

function readRequests(
  filePath: string,
  state: { seenIds: Set<string> },
): DelegateControlRequest[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) {
    if (text.length === 0) state.seenIds.clear();
    return [];
  }
  const requests = text
    .slice(0, lastNewline)
    .split('\n')
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isControlRequest(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  const presentIds = new Set(requests.map((request) => request.id));
  const unread = requests.filter((request) => !state.seenIds.has(request.id));
  // Pruning IDs absent from the current bounded file makes parent compaction
  // observable even when truncate and append happen between child polls.
  state.seenIds = presentIds;
  return unread;
}

function formatRequests(requests: readonly DelegateControlRequest[]): string {
  return requests
    .map((request) =>
      request.kind === 'checkpoint'
        ? `Parent checkpoint request:\n${request.message}`
        : `Parent feedback (address this at this checkpoint):\n${request.message}`,
    )
    .join('\n\n');
}

function controlMessage(requests: readonly DelegateControlRequest[]) {
  return {
    customType: DELEGATE_CONTROL_MESSAGE_TYPE,
    content: formatRequests(requests),
    display: false,
  };
}

function acknowledge(request: DelegateControlRequest): void {
  try {
    process.stdout.write(
      `${JSON.stringify({
        type: 'delegate_control_ack',
        controlId: request.id,
        controlKind: request.kind,
        ...(request.generation === undefined
          ? {}
          : { controlGeneration: request.generation }),
        timestamp: Date.now(),
      })}\n`,
    );
  } catch {
    // The child may be closing stdout while the control is handled.
  }
}

/** Child side: feedback is steered; pause/resume gates provider requests. */
export function registerDelegateControl(
  pi: ExtensionAPI,
  filePath: string | undefined,
): void {
  if (!filePath?.trim()) return;
  pi.on('session_shutdown', () => {
    try {
      unlinkSync(filePath);
    } catch {
      // Parent close, detach cleanup, or an earlier shutdown may have removed it.
    }
  });
  const state = { seenIds: new Set<string>() };
  let pausedGeneration: number | undefined;
  let pendingPause: DelegateControlRequest | undefined;
  let acknowledgedGeneration: number | undefined;

  const consume = (): DelegateControlRequest[] => {
    const conversational: DelegateControlRequest[] = [];
    for (const request of readRequests(filePath, state)) {
      if (request.kind === 'pause') {
        if (
          request.generation !== undefined &&
          (pausedGeneration === undefined ||
            request.generation >= pausedGeneration)
        )
          pausedGeneration = request.generation;
        pendingPause = request;
      } else if (request.kind === 'resume') {
        if (request.generation === pausedGeneration) {
          if (
            pendingPause &&
            acknowledgedGeneration !== pendingPause.generation
          )
            acknowledge(pendingPause);
          acknowledgedGeneration = pausedGeneration;
          pausedGeneration = undefined;
          pendingPause = undefined;
        }
        acknowledge(request);
      } else conversational.push(request);
    }
    return conversational;
  };

  let retryConversational: DelegateControlRequest[] = [];
  const deliver = () => {
    const requests = [...retryConversational, ...consume()];
    if (requests.length === 0) return;
    try {
      pi.sendMessage(controlMessage(requests), {
        deliverAs: 'steer',
        triggerTurn: true,
      });
      retryConversational = [];
      for (const request of requests) acknowledge(request);
    } catch {
      // Keep accepted controls pending when sendMessage has an unknown outcome.
      retryConversational = requests;
    }
  };

  const waitForResume = async () => {
    deliver();
    while (pausedGeneration !== undefined) {
      const generation = pausedGeneration;
      if (acknowledgedGeneration !== generation && pendingPause) {
        acknowledge(pendingPause);
        acknowledgedGeneration = generation;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, DELEGATE_CONTROL_POLL_MS),
      );
      deliver();
    }
  };

  pi.on('before_agent_start', async () => {
    const requests = consume();
    if (pausedGeneration !== undefined) await waitForResume();
    if (requests.length === 0) return;
    for (const request of requests) acknowledge(request);
    return { message: controlMessage(requests) };
  });
  pi.on('before_provider_request', waitForResume);
  pi.on('tool_execution_end', deliver);
  // turn_end runs after the turn's tool results have been finalized and
  // persisted, so a consumed pause can safely enter the barrier here instead
  // of waiting for another provider request that may never be started.
  pi.on('turn_end', async () => {
    deliver();
    if (pausedGeneration !== undefined) await waitForResume();
  });
  pi.on('turn_start', deliver);
}

export function checkpointRequestMessage(): string {
  return 'Stop starting new work now. Save or commit only a coherent, syntactically inspectable partial state, then return a short partial status with what is complete, what remains, and any validation run. Do not claim the task is complete unless it is complete.';
}
