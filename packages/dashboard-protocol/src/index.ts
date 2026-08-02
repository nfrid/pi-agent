/** Framework-independent wire types for the Pi bridge and dashboard browser API. */
export { queryViaCodexAppServer } from './usage-app-server.js';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 512 * 1024;

export type RuntimeLiveState =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'aborting'
  | 'stopping'
  | 'failed';
export type RuntimeOwnership = 'external' | 'managed';

export interface InteractionSnapshot {
  id: string;
  type: 'ask_user';
  question: string;
  choices: readonly {
    label: string;
    value: string;
    description?: string;
    preview?: string;
    custom?: boolean;
  }[];
  allowCustom: boolean;
  customLabel?: string;
  createdAt: number;
}

export interface SessionSnapshot {
  id: string;
  file?: string;
  name?: string;
  cwd?: string;
  leafId?: string;
  entries: readonly unknown[];
}

export interface RuntimeSnapshot {
  runtimeId: string;
  ownership: RuntimeOwnership;
  pid: number;
  cwd: string;
  workspaceHint?: string;
  tmux?: {
    session: string;
    windowId: string;
    paneId: string;
    displayTarget: string;
  };
  liveState: RuntimeLiveState;
  session: SessionSnapshot;
  model?: { provider: string; model: string; thinking?: string };
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent?: number | null;
  };
  pendingInteractions: readonly InteractionSnapshot[];
  lastError?: string;
  online?: boolean;
  lastSeenAt?: number;
}

export type BridgeEvent =
  | {
      type: 'runtime.hello';
      protocolVersion: number;
      /** One-time credential issued for a managed launch. */
      token?: string;
      /** Stable credential used by this runtime on every reconnect. */
      identityToken?: string;
      snapshot: RuntimeSnapshot;
    }
  | {
      type: 'runtime.heartbeat';
      state: RuntimeLiveState;
      snapshot?: Partial<RuntimeSnapshot>;
    }
  | {
      type: 'runtime.stateChanged';
      state: RuntimeLiveState;
      snapshot?: Partial<RuntimeSnapshot>;
    }
  | { type: 'session.changed'; session: SessionSnapshot }
  | { type: 'session.snapshot'; session: SessionSnapshot }
  | { type: 'message.started'; sessionId: string; message: unknown }
  | { type: 'message.updated'; sessionId: string; message: unknown }
  | { type: 'message.finished'; sessionId: string; message: unknown }
  | { type: 'tool.started'; sessionId: string; tool: unknown }
  | { type: 'tool.updated'; sessionId: string; tool: unknown }
  | { type: 'tool.finished'; sessionId: string; tool: unknown }
  | { type: 'agent.settled'; sessionId: string }
  | { type: 'interaction.requested'; interaction: InteractionSnapshot }
  | { type: 'interaction.resolved'; interactionId: string; resolution: unknown }
  | { type: 'runtime.goodbye'; reason?: string };

export interface BridgeCommandBase {
  id: string;
}
export type BridgeCommand =
  | (BridgeCommandBase & {
      type: 'prompt' | 'steer' | 'followUp';
      text: string;
    })
  | (BridgeCommandBase & { type: 'abort' | 'shutdown' })
  | (BridgeCommandBase & { type: 'setModel'; provider: string; model: string })
  | (BridgeCommandBase & { type: 'setThinking'; level: string })
  | (BridgeCommandBase & {
      type: 'interaction.answer';
      interactionId: string;
      answer: unknown;
    })
  | (BridgeCommandBase & { type: 'interaction.cancel'; interactionId: string });

export type BridgeFrame =
  | { kind: 'event'; event: BridgeEvent; seq: number }
  | { kind: 'command'; command: BridgeCommand }
  | { kind: 'ack'; id: string; ok: true; result?: unknown }
  | { kind: 'ack'; id: string; ok: false; error: string };

export interface BrowserSnapshot {
  revision: number;
  runtimes: readonly RuntimeSnapshot[];
  workspaces: readonly WorkspaceTarget[];
  sessions: readonly SessionIndexEntry[];
  usage?: unknown;
  unread: readonly NotificationEvent[];
}

export interface WorkspaceTarget {
  id: string;
  name: string;
  path: string;
  canonicalPath: string;
  gitRoot?: string;
  source: 'tmux' | 'sesh-config' | 'zoxide' | 'directory';
  tmuxSession?: string;
  active: boolean;
}

export interface SessionIndexEntry {
  id: string;
  file: string;
  cwd: string;
  workspaceId?: string;
  name?: string;
  updatedAt: number;
  activeRuntimeId?: string;
  entryCount?: number;
}

export interface NotificationEvent {
  id: string;
  kind: 'waiting' | 'failed' | 'runtime-exited' | 'settled';
  runtimeId?: string;
  sessionId?: string;
  title: string;
  body: string;
  createdAt: number;
  readAt?: number;
}

export interface StartRuntimeRequest {
  workspaceId: string;
  sessionId?: string;
  name?: string;
  model?: { provider: string; model: string; thinking?: string };
  initialPrompt?: string;
  acknowledgeSharedWorkingDirectory?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max = 4096): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= max
  );
}

function safeIdentifier(value: unknown, max: number): value is string {
  return (
    nonEmptyString(value, max) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function isRuntimeLiveState(value: unknown): value is RuntimeLiveState {
  return (
    value === 'idle' ||
    value === 'working' ||
    value === 'waiting' ||
    value === 'aborting' ||
    value === 'stopping' ||
    value === 'failed'
  );
}

export function validateBridgeCommand(value: unknown): BridgeCommand {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id, 128) ||
    !nonEmptyString(value.type, 64)
  )
    throw new Error('Invalid bridge command.');
  const type = value.type;
  if (type === 'prompt' || type === 'steer' || type === 'followUp') {
    if (!nonEmptyString(value.text, 100_000))
      throw new Error('Command text is required.');
    return { id: value.id, type, text: value.text };
  }
  if (type === 'abort' || type === 'shutdown') return { id: value.id, type };
  if (type === 'setModel') {
    if (
      !safeIdentifier(value.provider, 200) ||
      !safeIdentifier(value.model, 300)
    )
      throw new Error('Invalid model selection.');
    return { id: value.id, type, provider: value.provider, model: value.model };
  }
  if (type === 'setThinking') {
    if (!safeIdentifier(value.level, 64))
      throw new Error('Invalid thinking level.');
    return { id: value.id, type, level: value.level };
  }
  if (type === 'interaction.answer' || type === 'interaction.cancel') {
    if (!nonEmptyString(value.interactionId, 128))
      throw new Error('Invalid interaction id.');
    if (type === 'interaction.answer' && !('answer' in value))
      throw new Error('Answer is required.');
    return type === 'interaction.answer'
      ? {
          id: value.id,
          type,
          interactionId: value.interactionId,
          answer: value.answer,
        }
      : { id: value.id, type, interactionId: value.interactionId };
  }
  throw new Error(`Unsupported bridge command: ${type}`);
}

export function parseFrame(line: string | Uint8Array): BridgeFrame {
  const bytes =
    typeof line === 'string'
      ? new TextEncoder().encode(line).byteLength
      : line.byteLength;
  if (bytes > MAX_FRAME_BYTES)
    throw new Error('Protocol frame exceeds size limit.');
  const parsed: unknown = JSON.parse(
    typeof line === 'string' ? line : new TextDecoder().decode(line),
  );
  if (!isRecord(parsed) || typeof parsed.kind !== 'string')
    throw new Error('Invalid protocol frame.');
  if (parsed.kind === 'command')
    return { kind: 'command', command: validateBridgeCommand(parsed.command) };
  if (
    parsed.kind === 'event' &&
    isBridgeEvent(parsed.event) &&
    typeof parsed.seq === 'number' &&
    Number.isSafeInteger(parsed.seq) &&
    parsed.seq >= 0
  ) {
    return { kind: 'event', event: parsed.event, seq: parsed.seq };
  }
  if (
    parsed.kind === 'ack' &&
    nonEmptyString(parsed.id, 128) &&
    typeof parsed.ok === 'boolean'
  ) {
    if (parsed.ok)
      return { kind: 'ack', id: parsed.id, ok: true, result: parsed.result };
    if (!nonEmptyString(parsed.error, 1000))
      throw new Error('Invalid acknowledgement error.');
    return { kind: 'ack', id: parsed.id, ok: false, error: parsed.error };
  }
  throw new Error('Unexpected protocol frame.');
}

export function serializeFrame(frame: BridgeFrame): string {
  const line = JSON.stringify(frame);
  if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES)
    throw new Error('Protocol frame exceeds size limit.');
  return `${line}\n`;
}

export function validateStartRuntimeRequest(
  value: unknown,
): StartRuntimeRequest {
  if (!isRecord(value) || !safeIdentifier(value.workspaceId, 256))
    throw new Error('workspaceId is required.');
  const result: StartRuntimeRequest = { workspaceId: value.workspaceId };
  if (value.sessionId !== undefined && !nonEmptyString(value.sessionId, 256))
    throw new Error('Invalid sessionId.');
  if (value.name !== undefined && !nonEmptyString(value.name, 120))
    throw new Error('Invalid runtime name.');
  if (
    value.initialPrompt !== undefined &&
    typeof value.initialPrompt !== 'string'
  )
    throw new Error('Invalid initial prompt.');
  if (
    value.acknowledgeSharedWorkingDirectory !== undefined &&
    typeof value.acknowledgeSharedWorkingDirectory !== 'boolean'
  )
    throw new Error('Invalid acknowledgement.');
  if (value.sessionId) result.sessionId = value.sessionId;
  if (value.name) result.name = value.name;
  if (value.initialPrompt) result.initialPrompt = value.initialPrompt;
  if (value.acknowledgeSharedWorkingDirectory !== undefined)
    result.acknowledgeSharedWorkingDirectory =
      value.acknowledgeSharedWorkingDirectory;
  if (value.model !== undefined) {
    if (
      !isRecord(value.model) ||
      !safeIdentifier(value.model.provider, 200) ||
      !safeIdentifier(value.model.model, 300)
    )
      throw new Error('Invalid model.');
    if (
      value.model.thinking !== undefined &&
      !safeIdentifier(value.model.thinking, 64)
    )
      throw new Error('Invalid thinking level.');
    result.model = {
      provider: value.model.provider,
      model: value.model.model,
      ...(value.model.thinking ? { thinking: value.model.thinking } : {}),
    };
  }
  return result;
}

export function isBridgeEvent(value: unknown): value is BridgeEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  return (
    value.type.startsWith('runtime.') ||
    value.type.startsWith('session.') ||
    value.type.startsWith('message.') ||
    value.type.startsWith('tool.') ||
    value.type === 'agent.settled' ||
    value.type.startsWith('interaction.')
  );
}
