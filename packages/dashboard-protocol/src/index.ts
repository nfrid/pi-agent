/** Framework-independent wire types for the Pi bridge and dashboard browser API. */

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
  /** Explicit Pi session_info name, when one exists. */
  name?: string;
  /** Deterministic fallback derived from the first user message. */
  title?: string;
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
  | (BridgeCommandBase & { type: 'setSessionName'; name: string })
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
  /** Changes whenever the dashboard daemon process restarts. */
  serverId: string;
  /** Monotonically increasing state revision within one server process. */
  revision: number;
  runtimes: readonly RuntimeSnapshot[];
  workspaces: readonly WorkspaceTarget[];
  sessions: readonly SessionIndexEntry[];
  usage?: unknown;
  unread: readonly NotificationEvent[];
}

/** Messages emitted on the authenticated browser websocket. */
export type DashboardMessage =
  | { type: 'snapshot'; snapshot: BrowserSnapshot }
  | {
      type: 'event';
      serverId: string;
      revision: number;
      runtimeId: string;
      event: BridgeEvent;
      /** Transcript deltas omit the state snapshot to keep streaming bounded. */
      snapshot?: BrowserSnapshot;
    };

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
  /** Explicit Pi session_info name, when one exists. */
  name?: string;
  /** Deterministic fallback derived from the first user message. */
  title?: string;
  updatedAt: number;
  activeRuntimeId?: string;
  entryCount?: number;
}

export const SESSION_TITLE_MAX_LENGTH = 96;
export const SESSION_NAME_MAX_LENGTH = 512;

/**
 * Normalize a user message into a compact, stable dashboard title. Keeping
 * this in the wire package makes live and indexed sessions render identically.
 */
export function normalizeSessionTitle(value: string): string | undefined {
  const normalized = [...value.normalize('NFKC')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length <= SESSION_TITLE_MAX_LENGTH
    ? normalized
    : `${characters.slice(0, SESSION_TITLE_MAX_LENGTH - 1).join('')}…`;
}

function textFromMessageContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part) || typeof part.text !== 'string') return '';
      return part.text;
    })
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

/** Return the first non-empty user message title in Pi session entries. */
export function deriveSessionTitle(
  entries: readonly unknown[],
): string | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'message') continue;
    const message = isRecord(entry.message) ? entry.message : entry;
    if (message.role !== 'user') continue;
    const text = textFromMessageContent(message.content);
    const title = text ? normalizeSessionTitle(text) : undefined;
    if (title) return title;
  }
  return undefined;
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

export function validateSessionName(value: unknown): string {
  if (!safeIdentifier(value, SESSION_NAME_MAX_LENGTH))
    throw new Error('Invalid session name.');
  return value.trim();
}

export function validateSessionRenameRequest(value: unknown): { name: string } {
  if (!isRecord(value) || !onlyKeys(value, new Set(['name'])))
    throw new Error('Invalid session rename request.');
  return { name: validateSessionName(value.name) };
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
  if (type === 'setSessionName') {
    if (!onlyKeys(value, new Set(['id', 'type', 'name'])))
      throw new Error('Invalid session name command.');
    return { id: value.id, type, name: validateSessionName(value.name) };
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
    !nonEmptyString(value.initialPrompt, 100_000)
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

const runtimeSnapshotKeys = new Set([
  'runtimeId',
  'ownership',
  'pid',
  'cwd',
  'workspaceHint',
  'tmux',
  'liveState',
  'session',
  'model',
  'contextUsage',
  'pendingInteractions',
  'lastError',
  'online',
  'lastSeenAt',
]);
const sessionSnapshotKeys = new Set([
  'id',
  'file',
  'name',
  'title',
  'cwd',
  'leafId',
  'entries',
]);
const interactionKeys = new Set([
  'id',
  'type',
  'question',
  'choices',
  'allowCustom',
  'customLabel',
  'createdAt',
]);

function onlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function safePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (
    !isRecord(value) ||
    !onlyKeys(value, sessionSnapshotKeys) ||
    !safeIdentifier(value.id, 256) ||
    !Array.isArray(value.entries)
  )
    return false;
  return (
    (value.file === undefined || nonEmptyString(value.file, 4096)) &&
    (value.name === undefined ||
      nonEmptyString(value.name, SESSION_NAME_MAX_LENGTH)) &&
    (value.title === undefined ||
      nonEmptyString(value.title, SESSION_TITLE_MAX_LENGTH)) &&
    (value.cwd === undefined || nonEmptyString(value.cwd, 4096)) &&
    (value.leafId === undefined || safeIdentifier(value.leafId, 256))
  );
}

function isInteractionSnapshot(value: unknown): value is InteractionSnapshot {
  if (
    !isRecord(value) ||
    !onlyKeys(value, interactionKeys) ||
    !safeIdentifier(value.id, 256) ||
    value.type !== 'ask_user' ||
    !nonEmptyString(value.question, 100_000) ||
    !Array.isArray(value.choices) ||
    typeof value.allowCustom !== 'boolean' ||
    (value.customLabel !== undefined &&
      !nonEmptyString(value.customLabel, 512)) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt)
  )
    return false;
  return value.choices.every(
    (choice) =>
      isRecord(choice) &&
      onlyKeys(
        choice,
        new Set(['label', 'value', 'description', 'preview', 'custom']),
      ) &&
      nonEmptyString(choice.label, 512) &&
      safeIdentifier(choice.value, 512) &&
      (choice.description === undefined ||
        nonEmptyString(choice.description, 10_000)) &&
      (choice.preview === undefined ||
        nonEmptyString(choice.preview, 100_000)) &&
      (choice.custom === undefined || typeof choice.custom === 'boolean'),
  );
}

function isRuntimeSnapshot(
  value: unknown,
  partial = false,
): value is RuntimeSnapshot | Partial<RuntimeSnapshot> {
  if (!isRecord(value) || !onlyKeys(value, runtimeSnapshotKeys)) return false;
  if (partial && Object.keys(value).length === 0) return true;
  if (
    !partial &&
    (!safeIdentifier(value.runtimeId, 256) ||
      !safePid(value.pid) ||
      (value.ownership !== 'external' && value.ownership !== 'managed') ||
      !nonEmptyString(value.cwd, 4096) ||
      !isRuntimeLiveState(value.liveState) ||
      !isSessionSnapshot(value.session) ||
      !Array.isArray(value.pendingInteractions) ||
      !value.pendingInteractions.every(isInteractionSnapshot))
  )
    return false;
  if (value.runtimeId !== undefined && !safeIdentifier(value.runtimeId, 256))
    return false;
  if (
    value.ownership !== undefined &&
    value.ownership !== 'external' &&
    value.ownership !== 'managed'
  )
    return false;
  if (value.pid !== undefined && !safePid(value.pid)) return false;
  if (value.cwd !== undefined && !nonEmptyString(value.cwd, 4096)) return false;
  if (
    value.workspaceHint !== undefined &&
    !nonEmptyString(value.workspaceHint, 512)
  )
    return false;
  if (value.liveState !== undefined && !isRuntimeLiveState(value.liveState))
    return false;
  if (value.session !== undefined && !isSessionSnapshot(value.session))
    return false;
  if (
    value.pendingInteractions !== undefined &&
    (!Array.isArray(value.pendingInteractions) ||
      !value.pendingInteractions.every(isInteractionSnapshot))
  )
    return false;
  if (value.tmux !== undefined) {
    if (
      !isRecord(value.tmux) ||
      !onlyKeys(
        value.tmux,
        new Set(['session', 'windowId', 'paneId', 'displayTarget']),
      ) ||
      !safeIdentifier(value.tmux.session, 512) ||
      !safeIdentifier(value.tmux.windowId, 128) ||
      !safeIdentifier(value.tmux.paneId, 128) ||
      !safeIdentifier(value.tmux.displayTarget, 768)
    )
      return false;
  }
  if (value.model !== undefined) {
    if (
      !isRecord(value.model) ||
      !onlyKeys(value.model, new Set(['provider', 'model', 'thinking'])) ||
      !safeIdentifier(value.model.provider, 200) ||
      !safeIdentifier(value.model.model, 300) ||
      (value.model.thinking !== undefined &&
        !safeIdentifier(value.model.thinking, 64))
    )
      return false;
  }
  if (value.contextUsage !== undefined) {
    if (
      !isRecord(value.contextUsage) ||
      !onlyKeys(
        value.contextUsage,
        new Set(['tokens', 'contextWindow', 'percent']),
      ) ||
      (value.contextUsage.tokens !== null &&
        (typeof value.contextUsage.tokens !== 'number' ||
          !Number.isFinite(value.contextUsage.tokens))) ||
      typeof value.contextUsage.contextWindow !== 'number' ||
      !Number.isFinite(value.contextUsage.contextWindow) ||
      (value.contextUsage.percent !== undefined &&
        value.contextUsage.percent !== null &&
        (typeof value.contextUsage.percent !== 'number' ||
          !Number.isFinite(value.contextUsage.percent)))
    )
      return false;
  }
  return (
    (value.lastError === undefined ||
      nonEmptyString(value.lastError, 10_000)) &&
    (value.online === undefined || typeof value.online === 'boolean') &&
    (value.lastSeenAt === undefined ||
      (typeof value.lastSeenAt === 'number' &&
        Number.isFinite(value.lastSeenAt)))
  );
}

export function isBridgeEvent(value: unknown): value is BridgeEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'runtime.hello':
      return (
        onlyKeys(
          value,
          new Set([
            'type',
            'protocolVersion',
            'token',
            'identityToken',
            'snapshot',
          ]),
        ) &&
        value.protocolVersion === PROTOCOL_VERSION &&
        (value.token === undefined || safeIdentifier(value.token, 512)) &&
        (value.identityToken === undefined ||
          safeIdentifier(value.identityToken, 512)) &&
        isRuntimeSnapshot(value.snapshot)
      );
    case 'runtime.heartbeat':
    case 'runtime.stateChanged':
      return (
        onlyKeys(value, new Set(['type', 'state', 'snapshot'])) &&
        isRuntimeLiveState(value.state) &&
        (value.snapshot === undefined ||
          isRuntimeSnapshot(value.snapshot, true))
      );
    case 'session.changed':
    case 'session.snapshot':
      return (
        onlyKeys(value, new Set(['type', 'session'])) &&
        isSessionSnapshot(value.session)
      );
    case 'message.started':
    case 'message.updated':
    case 'message.finished':
      return (
        onlyKeys(value, new Set(['type', 'sessionId', 'message'])) &&
        safeIdentifier(value.sessionId, 256) &&
        'message' in value
      );
    case 'tool.started':
    case 'tool.updated':
    case 'tool.finished':
      return (
        onlyKeys(value, new Set(['type', 'sessionId', 'tool'])) &&
        safeIdentifier(value.sessionId, 256) &&
        'tool' in value
      );
    case 'agent.settled':
      return (
        onlyKeys(value, new Set(['type', 'sessionId'])) &&
        safeIdentifier(value.sessionId, 256)
      );
    case 'interaction.requested':
      return (
        onlyKeys(value, new Set(['type', 'interaction'])) &&
        isInteractionSnapshot(value.interaction)
      );
    case 'interaction.resolved':
      return (
        onlyKeys(value, new Set(['type', 'interactionId', 'resolution'])) &&
        safeIdentifier(value.interactionId, 256) &&
        'resolution' in value
      );
    case 'runtime.goodbye':
      return (
        onlyKeys(value, new Set(['type', 'reason'])) &&
        (value.reason === undefined || nonEmptyString(value.reason, 512))
      );
    default:
      return false;
  }
}
