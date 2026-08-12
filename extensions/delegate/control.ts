import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
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
  | {
      type: 'ack';
      participantId: string;
      kind: 'pause';
      generation: number;
    }
  | { type: 'close'; participantId: string };

export interface DelegateControlChannel {
  readonly participantId: string;
  readonly filePath: string;
  readonly ownerSessionId?: string;
  enqueue: (
    kind: 'feedback' | 'checkpoint',
    message: string,
  ) => DelegateControlEnqueueResult;
  pause: (generation: number) => DelegateControlEnqueueResult;
  resume: (generation: number) => DelegateControlEnqueueResult;
  acknowledge: (kind: DelegateControlKind, generation?: number) => void;
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

function controlPath(sessionPath: string): string {
  return `${sessionPath}.${process.pid}.${++channelCounter}.control`;
}

/** Parent side of a private child control inbox. */
export function createDelegateControlChannel(
  sessionPath: string,
  ownerSessionId?: string,
): DelegateControlChannel {
  const filePath = controlPath(sessionPath);
  const participantId = filePath;
  let closed = false;
  let sequence = 0;
  let requestCount = 0;

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
    if (!options.bypassLimits && requestCount >= MAX_DELEGATE_CONTROL_REQUESTS)
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
      if (!options.bypassLimits) requestCount++;
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
    acknowledge(kind, generation) {
      if (kind === 'pause' && typeof generation === 'number')
        emitLifecycle({ type: 'ack', participantId, kind, generation });
    },
    close() {
      if (closed) return;
      closed = true;
      activeChannels.delete(participantId);
      emitLifecycle({ type: 'close', participantId });
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
  state: { offset: number; inode?: number },
): DelegateControlRequest[] {
  let text: string;
  let inode: number | undefined;
  try {
    const stats = statSync(filePath);
    inode = typeof stats.ino === 'number' ? stats.ino : undefined;
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  if (inode !== state.inode || text.length < state.offset) state.offset = 0;
  state.inode = inode;
  const complete = text.slice(state.offset);
  const lastNewline = complete.lastIndexOf('\n');
  if (lastNewline < 0) return [];
  state.offset += lastNewline + 1;
  return complete
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
  const state = { offset: 0, inode: undefined as number | undefined };
  let pausedGeneration: number | undefined;
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
      } else if (request.kind === 'resume') {
        if (request.generation === pausedGeneration)
          pausedGeneration = undefined;
      } else conversational.push(request);
    }
    return conversational;
  };

  const deliver = () => {
    const requests = consume();
    if (requests.length === 0) return;
    try {
      pi.sendMessage(controlMessage(requests), {
        deliverAs: 'steer',
        triggerTurn: true,
      });
      for (const request of requests) acknowledge(request);
    } catch {
      // An unknown send outcome must not replay feedback later.
    }
  };

  const waitForResume = async () => {
    deliver();
    while (pausedGeneration !== undefined) {
      const generation = pausedGeneration;
      if (acknowledgedGeneration !== generation) {
        acknowledge({
          id: `pause-${generation}`,
          kind: 'pause',
          generation,
          createdAt: Date.now(),
        });
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
  pi.on('turn_end', deliver);
  pi.on('turn_start', deliver);
}

export function checkpointRequestMessage(): string {
  return 'Stop starting new work now. Save or commit only a coherent, syntactically inspectable partial state, then return a short partial status with what is complete, what remains, and any validation run. Do not claim the task is complete unless it is complete.';
}
