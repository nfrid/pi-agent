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

export type DelegateControlKind = 'feedback' | 'checkpoint';

export interface DelegateControlRequest {
  id: string;
  kind: DelegateControlKind;
  message: string;
  createdAt: number;
}

export interface DelegateControlEnqueueResult {
  accepted: boolean;
  id?: string;
  reason?: string;
}

export interface DelegateControlChannel {
  readonly filePath: string;
  enqueue: (
    kind: DelegateControlKind,
    message: string,
  ) => DelegateControlEnqueueResult;
  close: () => void;
}

let channelCounter = 0;

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function controlPath(sessionPath: string): string {
  // A continuation can overlap a still-settling background job. Keep each
  // invocation's inbox separate rather than allowing one child to consume
  // another child's feedback.
  return `${sessionPath}.${process.pid}.${++channelCounter}.control`;
}

/**
 * Create the parent side of a child control inbox. Appends are synchronous and
 * small: this makes concurrent tool calls linear without exposing a writable
 * socket or an unbounded queue to the child.
 */
export function createDelegateControlChannel(
  sessionPath: string,
): DelegateControlChannel {
  const filePath = controlPath(sessionPath);
  let closed = false;
  let sequence = 0;
  let requestCount = 0;

  return {
    filePath,
    enqueue(kind, message) {
      if (closed) return { accepted: false, reason: 'channel-closed' };
      const text = message.trim();
      if (!text) return { accepted: false, reason: 'empty-message' };
      if (bytes(text) > MAX_DELEGATE_CONTROL_MESSAGE_BYTES)
        return { accepted: false, reason: 'message-too-large' };
      if (requestCount >= MAX_DELEGATE_CONTROL_REQUESTS)
        return { accepted: false, reason: 'queue-full' };

      const request: DelegateControlRequest = {
        id: `${process.pid}-${Date.now()}-${++sequence}`,
        kind,
        message: text,
        createdAt: Date.now(),
      };
      const line = `${JSON.stringify(request)}\n`;
      let currentBytes = 0;
      try {
        currentBytes = existsSync(filePath) ? statSync(filePath).size : 0;
        if (currentBytes + bytes(line) > MAX_DELEGATE_CONTROL_FILE_BYTES)
          return { accepted: false, reason: 'queue-full' };
        appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
        // appendFileSync's mode applies only on creation; make the privacy
        // boundary explicit for pre-existing state directories/filesystems.
        try {
          chmodSync(filePath, 0o600);
        } catch {
          // The append succeeded; a chmod failure must not turn a queued
          // message into a duplicate when the caller retries.
        }
        requestCount++;
        return { accepted: true, id: request.id };
      } catch (error) {
        return {
          accepted: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        unlinkSync(filePath);
      } catch {
        // The child may already have removed or never created the inbox.
      }
    },
  };
}

function isControlRequest(value: unknown): value is DelegateControlRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<DelegateControlRequest>;
  return (
    typeof request.id === 'string' &&
    (request.kind === 'feedback' || request.kind === 'checkpoint') &&
    typeof request.message === 'string' &&
    bytes(request.message) <= MAX_DELEGATE_CONTROL_MESSAGE_BYTES &&
    typeof request.createdAt === 'number'
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
    })
    .slice(0, MAX_DELEGATE_CONTROL_REQUESTS);
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
        timestamp: Date.now(),
      })}\n`,
    );
  } catch {
    // The child may be closing its stdout while the control is being handled.
  }
}

/**
 * Install the child side of the control inbox. Controls are consumed only at
 * Pi boundaries: before a model turn starts, or after a tool has completed.
 * This avoids interrupting an in-flight edit/tool call while still allowing a
 * running child to receive bounded feedback without a fabricated user turn.
 */
export function registerDelegateControl(
  pi: ExtensionAPI,
  filePath: string | undefined,
): void {
  if (!filePath?.trim()) return;
  const state = { offset: 0, inode: undefined as number | undefined };

  const take = () => readRequests(filePath, state);
  const deliver = () => {
    const requests = take();
    if (requests.length === 0) return;
    try {
      pi.sendMessage(controlMessage(requests), {
        deliverAs: 'steer',
        triggerTurn: true,
      });
      for (const request of requests) acknowledge(request);
    } catch {
      // Leave an unacknowledged request visible to the parent. The inbox offset
      // is intentionally retained: a later checkpoint cannot safely replay a
      // message after an unknown send outcome, so the parent can continue the
      // child with the original feedback if required.
    }
  };

  pi.on('before_agent_start', () => {
    const requests = take();
    if (requests.length === 0) return;
    for (const request of requests) acknowledge(request);
    return { message: controlMessage(requests) };
  });
  pi.on('tool_execution_end', deliver);
  pi.on('turn_end', deliver);
  pi.on('turn_start', deliver);
}

export function checkpointRequestMessage(): string {
  return 'Stop starting new work now. Save or commit only a coherent, syntactically inspectable partial state, then return a short partial status with what is complete, what remains, and any validation run. Do not claim the task is complete unless it is complete.';
}
