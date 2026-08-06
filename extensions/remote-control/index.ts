import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type ActionInvocation,
  createRuntimeCapabilitySnapshot,
  findActionDescriptor,
  isActionAvailable,
  NonIdempotentActionIdGuard,
  parseActionInput,
  parseActionInvocation,
  type RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import {
  type BridgeCommand,
  type BridgeEvent,
  type BridgeImageAttachment,
  deriveSessionTitle,
  type InteractionSnapshot,
  MAX_FRAME_BYTES,
  MAX_QUEUE_DRAFT_TEXT,
  MAX_QUEUE_DRAFT_TOTAL_TEXT,
  MAX_QUEUE_DRAFTS,
  type NormalizedMessagePayload,
  type NormalizedToolPayload,
  PROTOCOL_VERSION,
  parseFrame,
  type QueueDraft,
  type QueueDraftAddCommand,
  type QueueDraftMode,
  type QueueDraftRemoveCommand,
  type QueueDraftUpdateCommand,
  type RuntimeExtensionSurface,
  type RuntimeLiveState,
  type RuntimeSnapshot,
  redactImageData,
  type SessionSnapshot,
  serializeFrame,
} from '../../packages/dashboard-protocol/src/index';
import { executeActivityGroupsAction } from '../activity-groups/actions';
import {
  ACTIVITY_GROUPS_ACTION_ID,
  activityGroupsCapabilitySnapshot,
  activityGroupsManifest,
} from '../activity-groups/contribution';
import {
  getInteractionBroker,
  type InteractionBroker,
} from '../ask-user/broker';
import {
  ASK_USER_ANSWER_ACTION_ID,
  ASK_USER_CANCEL_ACTION_ID,
  askUserCapabilitySnapshot,
  askUserManifest,
} from '../ask-user/contribution';
import {
  delegateCapabilitySnapshot,
  delegateManifest,
} from '../delegate/contribution';
import { isGenuineAgentSettlement } from '../shared/runtime/agent-lifecycle';
import { defineExtension } from '../shared/runtime/extension';
import { liveExtensionSurfaceHub } from '../shared/runtime/live-surfaces';
import { tasksCapabilitySnapshot, tasksManifest } from '../tasks/contribution';
import {
  RUNTIME_ABORT_ACTION_ID,
  RUNTIME_SHUTDOWN_ACTION_ID,
  remoteControlCapabilitySnapshot,
  remoteControlManifest,
  SESSION_COMPACT_ACTION_ID,
} from './contribution';

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_JSON_PAYLOAD_BYTES = 460_000;
export const BRIDGE_COMMAND_QUEUE_LIMIT = 64;
const BRIDGE_WRITE_QUEUE_LIMIT = 128;
const BRIDGE_WRITE_QUEUE_BYTES = 1 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 5_000;

const CONTRIBUTION_MANIFESTS = [
  askUserManifest,
  activityGroupsManifest,
  remoteControlManifest,
  delegateManifest,
  tasksManifest,
] as const;
const RUNTIME_CAPABILITIES = createRuntimeCapabilitySnapshot(
  CONTRIBUTION_MANIFESTS,
  [
    ...askUserCapabilitySnapshot.capabilities,
    ...activityGroupsCapabilitySnapshot.capabilities,
    ...remoteControlCapabilitySnapshot.capabilities,
    ...delegateCapabilitySnapshot.capabilities,
    ...tasksCapabilitySnapshot.capabilities,
  ],
);

type CommandHandler = (
  command: BridgeCommand,
  capabilities: RuntimeCapabilitySnapshot,
) => Promise<unknown>;

type CommandInfo = ReturnType<ExtensionAPI['getCommands']>[number];
type EventRecord = Record<string, unknown>;

function eventRecord(value: unknown): EventRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as EventRecord)
    : {};
}

export function withoutOpaqueData(event: BridgeEvent): BridgeEvent {
  if (event.type.startsWith('message.') && 'message' in event) {
    const message = event.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const { data, ...canonical } = message as Record<string, unknown>;
      const deliveryMode = directString(eventRecord(data), 'deliveryMode');
      return {
        ...event,
        message: {
          ...canonical,
          ...(deliveryMode === 'steer'
            ? { data: { deliveryMode: 'steer' } }
            : {}),
        },
      };
    }
  }
  if (event.type.startsWith('tool.') && 'tool' in event) {
    const tool = event.tool;
    if (tool && typeof tool === 'object' && !Array.isArray(tool)) {
      const { data: _data, ...canonical } = tool as Record<string, unknown>;
      return { ...event, tool: canonical };
    }
  }
  return event;
}

function directValue(record: EventRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function directString(record: EventRecord, key: string): string | undefined {
  const value = directValue(record, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Tool execution events already carry the canonical live result. Forwarding
 * Pi's later toolResult message as a second transcript entity would duplicate
 * the tool and introduce a false activity-group boundary.
 */
export function shouldForwardLiveMessage(value: unknown): boolean {
  const event = eventRecord(value);
  const message = eventRecord(directValue(event, 'message'));
  const role = directString(message, 'role') ?? directString(event, 'role');
  return role !== 'toolResult';
}

function directIdentifier(
  record: EventRecord,
  key: string,
): string | number | undefined {
  const value = directValue(record, key);
  return (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

function safeIdentityPart(value: string | number): string {
  return Array.from(String(value), (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? '?' : character;
  })
    .join('')
    .slice(0, 240);
}

function appendMessageContent(previous: unknown, delta: unknown): unknown {
  if (typeof delta !== 'string') return previous ?? delta ?? null;
  if (typeof previous === 'string') return previous + delta;
  if (previous === undefined || previous === null) return delta;
  if (Array.isArray(previous)) {
    const next = [...previous];
    const last = next.at(-1);
    if (
      last &&
      typeof last === 'object' &&
      !Array.isArray(last) &&
      (last as Record<string, unknown>).type === 'text' &&
      typeof (last as Record<string, unknown>).text === 'string'
    ) {
      next[next.length - 1] = {
        ...(last as Record<string, unknown>),
        text: `${(last as Record<string, unknown>).text}${delta}`,
      };
      return next;
    }
    next.push({ type: 'text', text: delta });
    return next;
  }
  return `${String(previous)}${delta}`;
}

/**
 * Converts Pi's live event wrappers to the protocol's explicit live payloads.
 * Identity lookup intentionally only examines documented, named wrapper fields;
 * provider data is opaque and is never searched recursively for IDs.
 */
export class LiveEventNormalizer {
  private identitySequence = 0;
  private activeMessage:
    | { messageId: string; identityKey?: string; content?: unknown }
    | undefined;

  constructor(private readonly runtimeEpoch: string = randomUUID()) {}

  reset(): void {
    this.activeMessage = undefined;
  }

  normalizeMessage(
    phase: 'started' | 'updated' | 'finished',
    value: unknown,
  ): NormalizedMessagePayload {
    const event = eventRecord(value);
    const message = eventRecord(directValue(event, 'message'));
    const assistantEvent = eventRecord(
      directValue(event, 'assistantMessageEvent'),
    );
    const responseId =
      directIdentifier(event, 'responseId') ??
      directIdentifier(message, 'responseId') ??
      directIdentifier(assistantEvent, 'responseId');
    const timestamp =
      directIdentifier(event, 'timestamp') ??
      directIdentifier(message, 'timestamp');
    const identityKey =
      responseId !== undefined
        ? `response:${safeIdentityPart(responseId)}`
        : timestamp !== undefined
          ? `timestamp:${safeIdentityPart(timestamp)}`
          : undefined;

    let messageId: string;
    if (phase === 'started') {
      messageId = identityKey
        ? identityKey
        : `${this.runtimeEpoch}:${++this.identitySequence}`;
      this.activeMessage = { messageId, identityKey };
    } else if (this.activeMessage) {
      // A responseId is often only present on the final message wrapper. The
      // live ID established by start remains authoritative for this stream.
      messageId = this.activeMessage.messageId;
      this.activeMessage.identityKey ??= identityKey;
    } else {
      messageId = identityKey
        ? identityKey
        : `${this.runtimeEpoch}:${++this.identitySequence}`;
    }

    // Pi's message wrapper contains the complete message. Only use a delta
    // when no complete content is present, and accumulate it for the active
    // message so an update never replaces the already-rendered prefix.
    const fullContent = Object.hasOwn(message, 'content')
      ? directValue(message, 'content')
      : Object.hasOwn(event, 'content')
        ? directValue(event, 'content')
        : Object.hasOwn(assistantEvent, 'content')
          ? directValue(assistantEvent, 'content')
          : undefined;
    const rawContent =
      fullContent !== undefined
        ? fullContent
        : Object.hasOwn(assistantEvent, 'delta')
          ? appendMessageContent(
              this.activeMessage?.content,
              directValue(assistantEvent, 'delta'),
            )
          : (this.activeMessage?.content ?? null);
    const safeContent = jsonSafe(rawContent, MAX_FRAME_BYTES);
    if (this.activeMessage) this.activeMessage.content = safeContent;
    const turnId =
      directIdentifier(event, 'turnId') ?? directIdentifier(message, 'turnId');
    const role =
      directString(message, 'role') ??
      directString(event, 'role') ??
      'assistant';
    const rawData = Object.hasOwn(message, 'data')
      ? directValue(message, 'data')
      : directValue(event, 'data');
    const safeData =
      rawData === undefined ? undefined : jsonSafe(rawData, MAX_FRAME_BYTES);
    const payload: NormalizedMessagePayload = {
      messageId,
      role,
      content: safeContent,
      phase,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(turnId !== undefined ? { turnId: String(turnId) } : {}),
      ...(Array.isArray(directValue(message, 'toolCallIds'))
        ? {
            toolCallIds: (directValue(message, 'toolCallIds') as unknown[])
              .filter((item): item is string => typeof item === 'string')
              .slice(0, 128),
          }
        : {}),
      ...(safeData === undefined ? {} : { data: safeData }),
    };
    if (phase === 'finished') this.activeMessage = undefined;
    return payload;
  }

  normalizeTool(
    phase: 'started' | 'updated' | 'finished',
    value: unknown,
  ): NormalizedToolPayload {
    const event = eventRecord(value);
    const suppliedId = directValue(event, 'toolCallId');
    const toolCallId =
      typeof suppliedId === 'string' && suppliedId.length > 0
        ? suppliedId
        : `${this.runtimeEpoch}:tool:${++this.identitySequence}`;
    const name = directString(event, 'toolName') ?? 'tool';
    const suppliedStatus = directString(event, 'status');
    const status =
      suppliedStatus === 'pending' ||
      suppliedStatus === 'running' ||
      suppliedStatus === 'completed' ||
      suppliedStatus === 'success' ||
      suppliedStatus === 'error' ||
      suppliedStatus === 'failed'
        ? suppliedStatus
        : phase === 'finished'
          ? directValue(event, 'isError') === true
            ? 'error'
            : 'completed'
          : 'running';
    const payload: NormalizedToolPayload = {
      toolCallId,
      name,
      phase,
      ...(directValue(event, 'args') !== undefined
        ? { arguments: jsonSafe(directValue(event, 'args'), MAX_FRAME_BYTES) }
        : {}),
      ...(directValue(event, 'result') !== undefined
        ? { result: jsonSafe(directValue(event, 'result'), MAX_FRAME_BYTES) }
        : {}),
      ...(typeof directValue(event, 'isError') === 'boolean'
        ? { isError: directValue(event, 'isError') as boolean }
        : {}),
      status,
      ...(directIdentifier(event, 'turnId') !== undefined
        ? { turnId: String(directIdentifier(event, 'turnId')) }
        : {}),
    };
    return payload;
  }
}

// Built-ins are dispatched by Pi's TUI, not AgentSession.prompt(), and are not
// returned by ExtensionAPI.getCommands(). Never let an unsupported one become
// literal model input merely because the bridge has no equivalent operation.
const PI_BUILTIN_COMMANDS = new Set([
  'settings',
  'model',
  'scoped-models',
  'export',
  'import',
  'share',
  'copy',
  'name',
  'session',
  'changelog',
  'hotkeys',
  'fork',
  'clone',
  'tree',
  'trust',
  'login',
  'logout',
  'new',
  'compact',
  'resume',
  'reload',
  'quit',
]);

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function parseArgs(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (current) args.push(current);
      current = '';
    } else current += character;
  }
  if (current) args.push(current);
  return args;
}

function substituteArgs(content: string, args: readonly string[]): string {
  const all = args.join(' ');
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, target, fallback, sliceStart, sliceLength, simple) => {
      if (target) {
        const value =
          target === '@' || target === 'ARGUMENTS'
            ? all
            : args[Number(target) - 1];
        return value || fallback;
      }
      if (sliceStart) {
        const start = Math.max(0, Number(sliceStart) - 1);
        return args
          .slice(start, sliceLength ? start + Number(sliceLength) : undefined)
          .join(' ');
      }
      if (simple === '@' || simple === 'ARGUMENTS') return all;
      return args[Number(simple) - 1] ?? '';
    },
  );
}

function commandParts(
  text: string,
): { name: string; args: string } | undefined {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1], args: match[2] ?? '' } : undefined;
}

export function expandDashboardInput(
  text: string,
  commands: readonly CommandInfo[],
): string {
  const invocation = commandParts(text);
  if (!invocation) return text;
  const command = commands.find((item) => item.name === invocation.name);
  if (!command || command.source === 'extension') return text;
  const raw = readFileSync(command.sourceInfo.path, 'utf8');
  const body = stripFrontmatter(raw).trim();
  if (command.source === 'skill') {
    const baseDir =
      command.sourceInfo.baseDir ?? path.dirname(command.sourceInfo.path);
    const skill = invocation.name.startsWith('skill:')
      ? invocation.name.slice(6)
      : invocation.name;
    const block = `<skill name="${skill}" location="${command.sourceInfo.path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
    return invocation.args.trim()
      ? `${block}\n\n${invocation.args.trim()}`
      : block;
  }
  return substituteArgs(body, parseArgs(invocation.args));
}

export async function dispatchDashboardInput(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  text: string,
  deliverAs?: 'steer' | 'followUp',
  images: readonly BridgeImageAttachment[] = [],
): Promise<{ accepted: true; command?: string }> {
  const invocation = commandParts(text);
  if (invocation && !deliverAs) {
    if (images.length > 0 && PI_BUILTIN_COMMANDS.has(invocation.name))
      throw new Error('Images cannot be attached to dashboard commands.');
    if (invocation.name === 'compact') {
      await ctx.compact({
        customInstructions: invocation.args.trim() || undefined,
      });
      return { accepted: true, command: 'compact' };
    }
    if (invocation.name === 'name') {
      if (!invocation.args.trim())
        throw new Error('Usage: /name <session name>');
      pi.setSessionName(invocation.args.trim());
      return { accepted: true, command: 'name' };
    }
    if (invocation.name === 'model') {
      const separator = invocation.args.indexOf('/');
      if (separator < 1) throw new Error('Usage: /model <provider/model>');
      const provider = invocation.args.slice(0, separator);
      const modelId = invocation.args.slice(separator + 1);
      const model = ctx.modelRegistry.find(provider, modelId);
      if (!model) throw new Error('Requested model is not available.');
      if (!(await pi.setModel(model)))
        throw new Error('Model authentication is unavailable.');
      return { accepted: true, command: 'model' };
    }
    if (invocation.name === 'quit') {
      ctx.shutdown();
      return { accepted: true, command: 'quit' };
    }
  }
  const commands = pi.getCommands();
  const known = invocation
    ? commands.find((item) => item.name === invocation.name)
    : undefined;
  if (
    invocation &&
    (known?.source === 'extension' || PI_BUILTIN_COMMANDS.has(invocation.name))
  ) {
    throw new Error(
      `Command "/${invocation.name}" is not available through the dashboard yet.`,
    );
  }
  const expanded = expandDashboardInput(text, commands);
  const content =
    images.length > 0
      ? [
          ...(expanded ? [{ type: 'text' as const, text: expanded }] : []),
          ...images.map((image) => {
            const stat = statSync(image.path);
            if (
              !stat.isFile() ||
              stat.size === 0 ||
              stat.size > 5 * 1024 * 1024
            )
              throw new Error('Invalid temporary image attachment.');
            return {
              type: 'image' as const,
              data: readFileSync(image.path).toString('base64'),
              mimeType: image.mediaType,
            };
          }),
        ]
      : expanded;
  pi.sendUserMessage(
    content as Parameters<ExtensionAPI['sendUserMessage']>[0],
    deliverAs ? { deliverAs } : undefined,
  );
  return { accepted: true };
}

export interface BridgeClientOptions {
  socketPath: string;
  /** Legacy launch token, retained for managed first hello. */
  token?: string;
  identityToken?: string;
  runtimeId: string;
  snapshot: () => RuntimeSnapshot;
  /** Session generation captured when a browser command enters the bridge. */
  commandScope?: () => string | undefined;
  handleCommand: CommandHandler;
  broker?: InteractionBroker;
  capabilities?: RuntimeCapabilitySnapshot;
  liveSurfaces?: {
    subscribe(
      listener: (surfaces: readonly RuntimeExtensionSurface[]) => void,
    ): () => void;
  };
  onLiveSurfacesChanged?: (
    surfaces: readonly RuntimeExtensionSurface[],
  ) => void;
}

/** Reconnecting JSONL client. It never queues browser commands while offline. */
export class BridgeClient {
  private socket: net.Socket | undefined;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = RECONNECT_MIN_MS;
  private buffer = '';
  private seq = 0;
  private commandQueue: Array<{
    command: BridgeCommand;
    socket: net.Socket;
    scope?: string;
  }> = [];
  private commandRunning = false;
  private queueDraftCommandsRunning = 0;
  private readonly actionCommandIds = new NonIdempotentActionIdGuard();
  private readonly effectiveCapabilities: RuntimeCapabilitySnapshot;
  private outboundQueue: Array<{
    socket: net.Socket;
    data: string;
    droppable: boolean;
  }> = [];
  private outboundBytes = 0;
  private writeBlocked = false;
  private unsubscribeBroker: (() => void) | undefined;
  private unsubscribeLiveSurfaces: (() => void) | undefined;

  constructor(private readonly options: BridgeClientOptions) {
    this.effectiveCapabilities = options.capabilities ?? RUNTIME_CAPABILITIES;
    this.unsubscribeBroker = options.broker?.subscribe((event) => {
      if (event.kind === 'requested') {
        this.sendEvent({
          type: 'interaction.requested',
          interaction: interactionSnapshot(event.interaction),
        });
      } else {
        this.sendEvent({
          type: 'interaction.resolved',
          interactionId: event.interaction.id,
          resolution: event.result,
        });
      }
    });
    this.unsubscribeLiveSurfaces = options.liveSurfaces?.subscribe(
      (surfaces) => {
        try {
          options.onLiveSurfacesChanged?.(surfaces);
          const current = options.snapshot();
          this.sendEvent({
            type: 'runtime.stateChanged',
            state: current.liveState,
            snapshot: { extensionSurfaces: surfaces },
          });
        } catch {
          // A surface publisher must not make a Pi mutation fail because the
          // bridge is offline or a stale cached snapshot is unavailable.
        }
      },
    );
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    this.unsubscribeBroker?.();
    this.unsubscribeBroker = undefined;
    this.unsubscribeLiveSurfaces?.();
    this.unsubscribeLiveSurfaces = undefined;
    this.commandQueue = [];
    this.clearOutboundQueue();
    this.socket?.destroy();
    this.socket = undefined;
  }

  sendEvent(event: BridgeEvent): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
    // The daemon requires runtime.hello to be the first frame. The connect
    // callback builds that authoritative snapshot from the latest context, so
    // events attempted before the handshake are safely covered by hello.
    if (socket.connecting) return false;
    const wireEvent: BridgeEvent =
      event.type === 'interaction.requested'
        ? { ...event, interaction: interactionSnapshot(event.interaction) }
        : event.type === 'interaction.resolved'
          ? { ...event, resolution: jsonSafe(event.resolution) }
          : withoutOpaqueData(event);
    let data: string;
    try {
      data = serializeFrame({
        kind: 'event',
        event: wireEvent,
        seq: ++this.seq,
      });
    } catch {
      // Optional provider payloads are not allowed to turn into a malformed
      // frame, and a serialization failure must not tear down the bridge.
      return false;
    }
    return this.enqueueOutbound(
      socket,
      data,
      wireEvent.type === 'message.updated' || wireEvent.type === 'tool.updated',
    );
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const socket = net.createConnection(this.options.socketPath);
    this.socket = socket;
    this.clearOutboundQueue();
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      let snapshot: RuntimeSnapshot;
      try {
        snapshot = this.options.snapshot();
      } catch {
        socket.destroy();
        return;
      }
      // The broker is authoritative at reconnect time. A cached snapshot can
      // still contain a question resolved while this bridge was offline.
      const interactions =
        this.options.broker?.list().map(interactionSnapshot) ?? [];
      snapshot = {
        ...snapshot,
        // One effective capability snapshot drives hello, runtime snapshot,
        // duplicate protection, and semantic dispatch.
        capabilities: this.effectiveCapabilities,
        ...(this.options.broker
          ? { pendingInteractions: interactions }
          : undefined),
      };
      const helloSent = this.sendEvent({
        type: 'runtime.hello',
        protocolVersion: PROTOCOL_VERSION,
        token: this.options.token,
        identityToken: this.options.identityToken,
        capabilities: {
          heartbeat: true,
          extensions: this.effectiveCapabilities,
        },
        snapshot,
      });
      if (!helloSent) return;
      // A daemon restart gets a complete interaction set, not only events
      // emitted after this connection was established.
      for (const interaction of interactions)
        this.sendEvent({ type: 'interaction.requested', interaction });
      this.startHeartbeat(socket);
    });
    socket.on('data', (chunk: string) => this.onData(socket, chunk));
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.stopHeartbeat();
      this.commandQueue = this.commandQueue.filter(
        (item) => item.socket !== socket,
      );
      this.clearOutboundQueue();
      this.socket = undefined;
      this.buffer = '';
      this.scheduleReconnect();
    });
  }

  private onData(socket: net.Socket, chunk: string): void {
    // Data delivered after close belongs to the old generation. It must not
    // enqueue work or be acknowledged on a replacement connection.
    if (socket !== this.socket) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES * 2) {
      this.socket?.destroy();
      this.buffer = '';
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          const frame = parseFrame(line);
          if (frame.kind === 'command') this.enqueue(frame.command, socket);
        } catch {
          // Malformed browser/daemon data is ignored; the socket remains
          // usable for the next bounded frame.
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private enqueue(command: BridgeCommand, socket: net.Socket): void {
    const item = {
      command,
      socket,
      scope: this.options.commandScope?.(),
    };
    // Draft edits are dashboard-owned state and must remain responsive while a
    // long-running semantic command is awaiting completion. Their store is
    // synchronous and independently bounded, so they can safely bypass the
    // serialized Pi command lane while retaining the captured session scope.
    if (isQueueDraftCommand(command)) {
      if (this.queueDraftCommandsRunning >= MAX_QUEUE_DRAFTS) {
        this.sendAck(
          socket,
          command.id,
          false,
          'Queue draft command capacity is full.',
        );
        return;
      }
      this.queueDraftCommandsRunning += 1;
      void this.executeCommand(item).finally(() => {
        this.queueDraftCommandsRunning -= 1;
      });
      return;
    }
    if (
      this.commandQueue.length + (this.commandRunning ? 1 : 0) >=
      BRIDGE_COMMAND_QUEUE_LIMIT
    ) {
      this.sendAck(socket, command.id, false, 'Command queue is full.');
      return;
    }
    if (command.type === 'action.invoke') {
      const action = this.effectiveCapabilities.manifests
        .flatMap((manifest) => manifest.actions)
        .find((item) => item.id === command.actionId);
      if (action && !action.idempotent) {
        const reservation = this.actionCommandIds.reserve(command.id);
        if (reservation === 'duplicate') {
          this.sendAck(
            socket,
            command.id,
            false,
            'Duplicate semantic action command ID.',
            'duplicate-action-id',
          );
          return;
        }
        if (reservation === 'capacity') {
          this.sendAck(
            socket,
            command.id,
            false,
            'Non-idempotent action command capacity is full.',
            'action-command-capacity',
          );
          return;
        }
      }
    }
    this.commandQueue.push(item);
    this.pumpCommands();
  }

  private async executeCommand(item: {
    command: BridgeCommand;
    socket: net.Socket;
    scope?: string;
  }): Promise<void> {
    // Commands received on a replaced generation are abandoned rather than
    // replayed. Replaying could duplicate a prompt after a daemon retry.
    if (item.socket !== this.socket || item.socket.destroyed) return;
    if (
      isQueueDraftCommand(item.command) &&
      item.scope !== this.options.commandScope?.()
    ) {
      this.sendAck(
        item.socket,
        item.command.id,
        false,
        'Queue draft command belongs to a replaced session.',
        'stale-session',
      );
      return;
    }
    try {
      const result = await this.options.handleCommand(
        item.command,
        this.effectiveCapabilities,
      );
      this.sendAck(item.socket, item.command.id, true, result);
    } catch (error) {
      this.sendAck(
        item.socket,
        item.command.id,
        false,
        error instanceof Error ? error.message : String(error),
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : undefined,
      );
    }
  }

  private pumpCommands(): void {
    if (this.commandRunning) return;
    const item = this.commandQueue.shift();
    if (!item) return;
    this.commandRunning = true;
    void this.executeCommand(item).finally(() => {
      this.commandRunning = false;
      this.pumpCommands();
    });
  }

  private sendAck(
    socket: net.Socket,
    id: string,
    ok: true,
    result?: unknown,
  ): void;
  private sendAck(
    socket: net.Socket,
    id: string,
    ok: false,
    result: string,
    code?: string,
  ): void;
  private sendAck(
    socket: net.Socket,
    id: string,
    ok: boolean,
    result?: unknown,
    code?: string,
  ): void {
    if (ok) {
      this.sendRaw(socket, {
        kind: 'ack',
        id,
        ok: true,
        result: result === undefined ? undefined : jsonSafe(result),
      });
    } else {
      const error = String(result ?? 'Command failed.').slice(0, 1_000);
      this.sendRaw(socket, {
        kind: 'ack',
        id,
        ok: false,
        error: error || 'Command failed.',
        ...(code ? { code: code.slice(0, 256) } : {}),
      });
    }
  }

  private sendRaw(
    socket: net.Socket,
    frame: Parameters<typeof serializeFrame>[0],
  ): void {
    if (socket !== this.socket || socket.destroyed || !socket.writable) return;
    let data: string;
    try {
      data = serializeFrame(frame);
    } catch {
      // A bad optional result is dropped rather than producing an invalid
      // frame or disconnecting a healthy bridge.
      return;
    }
    this.enqueueOutbound(socket, data, false);
  }

  private enqueueOutbound(
    socket: net.Socket,
    data: string,
    droppable: boolean,
  ): boolean {
    if (socket !== this.socket || socket.destroyed || !socket.writable)
      return false;
    const bytes = Buffer.byteLength(data);
    if (bytes > BRIDGE_WRITE_QUEUE_BYTES) return false;
    if (
      this.outboundQueue.length >= BRIDGE_WRITE_QUEUE_LIMIT ||
      this.outboundBytes + bytes > BRIDGE_WRITE_QUEUE_BYTES
    ) {
      this.dropQueuedStreaming();
    }
    if (
      this.outboundQueue.length >= BRIDGE_WRITE_QUEUE_LIMIT ||
      this.outboundBytes + bytes > BRIDGE_WRITE_QUEUE_BYTES
    ) {
      // State and interaction events are replayable on reconnect but cannot be
      // silently lost while a socket still appears healthy. Streaming deltas
      // may be dropped because the next update/session refresh supersedes them.
      if (!droppable) socket.destroy();
      return false;
    }
    this.outboundQueue.push({ socket, data, droppable });
    this.outboundBytes += bytes;
    this.pumpOutbound(socket);
    return true;
  }

  private dropQueuedStreaming(): void {
    if (!this.outboundQueue.some((item) => item.droppable)) return;
    this.outboundQueue = this.outboundQueue.filter((item) => {
      if (!item.droppable) return true;
      this.outboundBytes -= Buffer.byteLength(item.data);
      return false;
    });
  }

  private pumpOutbound(socket: net.Socket): void {
    if (
      socket !== this.socket ||
      socket.destroyed ||
      !socket.writable ||
      this.writeBlocked
    )
      return;
    while (this.outboundQueue.length > 0) {
      const item = this.outboundQueue.shift();
      if (!item) return;
      this.outboundBytes -= Buffer.byteLength(item.data);
      if (item.socket !== socket) continue;
      try {
        const accepted = socket.write(item.data);
        if (!accepted) {
          this.writeBlocked = true;
          socket.once('drain', () => {
            if (this.socket !== socket) return;
            this.writeBlocked = false;
            this.pumpOutbound(socket);
          });
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }
  }

  private clearOutboundQueue(): void {
    this.outboundQueue = [];
    this.outboundBytes = 0;
    this.writeBlocked = false;
  }

  private startHeartbeat(socket: net.Socket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.destroyed) {
        this.stopHeartbeat();
        return;
      }
      try {
        this.sendEvent({
          type: 'runtime.heartbeat',
          state: this.options.snapshot().liveState,
        });
      } catch {
        // The next heartbeat or a normal event will retry; no context is
        // dereferenced by the timer beyond this bounded snapshot read.
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

function jsonSafe(value: unknown, max = MAX_JSON_PAYLOAD_BYTES): unknown {
  try {
    const text = JSON.stringify(redactImageData(value));
    if (!text || Buffer.byteLength(text) > max) return null;
    return JSON.parse(text) as unknown;
  } catch {
    // Event schemas require the payload key to be present. Null is a valid,
    // bounded representation for an optional provider object that cannot be
    // cloned (for example, a cyclic or oversized value).
    return null;
  }
}

function sessionSnapshot(ctx: ExtensionContext): SessionSnapshot {
  const manager = ctx.sessionManager;
  const entries = manager.getBranch() as readonly unknown[];
  const serialized = jsonSafe(entries);
  const complete = Array.isArray(serialized);
  return {
    id: manager.getSessionId(),
    file: manager.getSessionFile(),
    name: manager.getSessionName(),
    title: deriveSessionTitle(entries),
    cwd: manager.getCwd(),
    leafId: manager.getLeafId() ?? undefined,
    entriesComplete: complete,
    entries: complete ? serialized : [],
  };
}

function modelSnapshot(ctx: ExtensionContext): RuntimeSnapshot['model'] {
  const model = ctx.model;
  if (!model) return undefined;
  return {
    provider: model.provider,
    model: model.id,
    thinking: ctx.thinkingLevel,
    supportsImages: model.input.includes('image'),
  };
}

function modelCatalogSnapshot(
  ctx: ExtensionContext,
): RuntimeSnapshot['modelCatalog'] {
  const registry = (
    ctx as unknown as {
      modelRegistry?: { getAll?: () => readonly unknown[] };
    }
  ).modelRegistry;
  const models = registry?.getAll?.() ?? [];
  return models.slice(0, 256).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.provider !== 'string' || typeof value.id !== 'string')
      return [];
    const input = Array.isArray(value.input) ? value.input : [];
    return [
      {
        provider: value.provider,
        model: value.id,
        ...(typeof value.name === 'string' ? { name: value.name } : {}),
        supportsImages: input.includes('image'),
      },
    ];
  });
}

function thinkingLevelsSnapshot(): string[] {
  // These are the stable ThinkingLevel values accepted by Pi 0.82.1. They
  // are data controls, not command names, and remain bounded on the wire.
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
}

function liveState(
  ctx: ExtensionContext,
  broker: InteractionBroker,
): RuntimeLiveState {
  if (broker.list().length > 0) return 'waiting';
  return ctx.isIdle() ? 'idle' : 'working';
}

function boundedText(value: unknown, max: number, fallback: string): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.slice(0, max) || fallback;
}

function boundedIdentifier(
  value: unknown,
  max: number,
  fallback: string,
): string {
  const text = Array.from(boundedText(value, max, fallback), (character) =>
    character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
      ? ''
      : character,
  ).join('');
  return text.slice(0, max) || fallback;
}

function queueDraftError(
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

function isQueueDraftCommand(
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

function interactionSnapshot(
  interaction: ReturnType<InteractionBroker['list']>[number],
): InteractionSnapshot {
  // Normalize every field even when the JSON is otherwise small enough to fit
  // a frame. Frame-size checks do not enforce the stricter shared schema.
  return {
    id: boundedIdentifier(interaction.id, 256, 'interaction'),
    type: 'ask_user',
    question: boundedText(interaction.question, 20_000, 'Question'),
    choices: interaction.choices.slice(0, 50).map((choice, index) => ({
      label: boundedText(choice.label, 512, `Choice ${index + 1}`),
      value: boundedText(choice.value, 512, `choice-${index + 1}`),
      ...(typeof choice.description === 'string' && choice.description
        ? { description: choice.description.slice(0, 2_000) }
        : {}),
      ...(typeof choice.preview === 'string' && choice.preview
        ? { preview: choice.preview.slice(0, 4_000) }
        : {}),
      ...(typeof choice.custom === 'boolean' ? { custom: choice.custom } : {}),
    })),
    allowCustom: interaction.allowCustom === true,
    rendererId: 'ask-user.question',
    answerActionId: ASK_USER_ANSWER_ACTION_ID,
    cancelActionId: ASK_USER_CANCEL_ACTION_ID,
    viewModel: {
      id: boundedIdentifier(interaction.id, 256, 'interaction'),
      question: boundedText(interaction.question, 20_000, 'Question'),
      // The full descriptions/previews remain on the protocol snapshot. The
      // view model is intentionally compact so advertising it cannot double
      // a near-limit interaction frame.
      choices: interaction.choices.slice(0, 50).map((choice) => ({
        label: boundedText(choice.label, 512, 'Choice'),
        value: boundedText(choice.value, 512, 'choice'),
        ...(choice.custom === true ? { custom: true } : {}),
      })),
      allowCustom: interaction.allowCustom === true,
      ...(typeof interaction.customLabel === 'string' && interaction.customLabel
        ? { customLabel: interaction.customLabel.slice(0, 512) }
        : {}),
    },
    ...(typeof interaction.customLabel === 'string' && interaction.customLabel
      ? { customLabel: interaction.customLabel.slice(0, 512) }
      : {}),
    createdAt:
      typeof interaction.createdAt === 'number' &&
      Number.isFinite(interaction.createdAt)
        ? interaction.createdAt
        : 0,
  };
}

async function dispatchSemanticAction(
  ctx: ExtensionContext,
  broker: InteractionBroker,
  command: Extract<BridgeCommand, { type: 'action.invoke' }>,
  capabilities: RuntimeCapabilitySnapshot,
): Promise<unknown> {
  const invocation: ActionInvocation = parseActionInvocation(command);
  const action = findActionDescriptor(
    CONTRIBUTION_MANIFESTS,
    invocation.actionId,
  );
  const advertisedAction = capabilities.manifests
    .flatMap((manifest) => manifest.actions)
    .find((candidate) => candidate.id === invocation.actionId);
  if (!advertisedAction)
    throw Object.assign(
      new Error(`Unknown dashboard action: ${invocation.actionId}`),
      { code: 'unknown-action' },
    );
  if (!action)
    throw Object.assign(
      new Error(`No adapter for dashboard action: ${invocation.actionId}`),
      { code: 'unknown-action' },
    );
  const available = isActionAvailable(advertisedAction, capabilities, {
    online: true,
    liveState:
      broker.list().length > 0 ? 'waiting' : ctx.isIdle() ? 'idle' : 'working',
    pendingInteractions: broker.list().length,
  });
  if (!available)
    throw Object.assign(
      new Error(`Dashboard action is unavailable: ${invocation.actionId}`),
      { code: 'unavailable-action' },
    );
  parseActionInput(advertisedAction, invocation.input);
  if (invocation.actionId === ASK_USER_ANSWER_ACTION_ID) {
    const input = invocation.input as { interactionId: string; answer: string };
    if (!broker.answer(input.interactionId, input.answer))
      throw Object.assign(
        new Error('Interaction is already resolved or the answer is invalid.'),
        {
          code: 'unavailable-action',
        },
      );
    return { accepted: true, actionId: invocation.actionId };
  }
  if (invocation.actionId === ASK_USER_CANCEL_ACTION_ID) {
    const input = invocation.input as { interactionId: string };
    if (!broker.cancel(input.interactionId))
      throw Object.assign(new Error('Interaction is already resolved.'), {
        code: 'unavailable-action',
      });
    return { accepted: true, actionId: invocation.actionId };
  }
  if (invocation.actionId === ACTIVITY_GROUPS_ACTION_ID)
    return executeActivityGroupsAction(invocation.input);
  if (invocation.actionId === SESSION_COMPACT_ACTION_ID) {
    const input = invocation.input as { customInstructions?: string };
    await ctx.compact({
      customInstructions: input.customInstructions || undefined,
    });
    return { accepted: true, actionId: invocation.actionId };
  }
  if (invocation.actionId === RUNTIME_ABORT_ACTION_ID) {
    ctx.abort();
    return { accepted: true, actionId: invocation.actionId };
  }
  if (invocation.actionId === RUNTIME_SHUTDOWN_ACTION_ID) {
    ctx.shutdown();
    return { accepted: true, actionId: invocation.actionId };
  }
  throw Object.assign(
    new Error(`No adapter for dashboard action: ${invocation.actionId}`),
    {
      code: 'unknown-action',
    },
  );
}

export async function dispatchDashboardCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  broker: InteractionBroker,
  command: BridgeCommand,
  capabilities = RUNTIME_CAPABILITIES,
  queueDrafts?: QueueDraftStore,
): Promise<unknown> {
  if (command.type === 'action.invoke')
    return dispatchSemanticAction(ctx, broker, command, capabilities);
  if (isQueueDraftCommand(command)) {
    if (!queueDrafts)
      throw queueDraftError(
        'queue-drafts-unavailable',
        'Queue drafts are unavailable for this runtime.',
      );
    if (command.type === 'queue.add' || command.type === 'queueDraft.add')
      return { accepted: true, draft: queueDrafts.add(command) };
    if (command.type === 'queue.update' || command.type === 'queueDraft.update')
      return { accepted: true, draft: queueDrafts.update(command) };
    queueDrafts.remove(command.clientId);
    return { accepted: true, clientId: command.clientId };
  }
  switch (command.type) {
    case 'prompt':
      if (!ctx.isIdle())
        throw new Error('Agent is working; choose steer or follow-up.');
      if (command.images?.length && !ctx.model?.input.includes('image'))
        throw new Error('The selected model does not support image input.');
      return dispatchDashboardInput(
        pi,
        ctx,
        command.text,
        undefined,
        command.images,
      );
    case 'steer':
    case 'followUp':
      if (command.images?.length && !ctx.model?.input.includes('image'))
        throw new Error('The selected model does not support image input.');
      return {
        ...(await dispatchDashboardInput(
          pi,
          ctx,
          command.text,
          command.type === 'steer' ? 'steer' : 'followUp',
          command.images,
        )),
        mode: command.type,
      };
    case 'abort':
      ctx.abort();
      return { accepted: true };
    case 'shutdown':
      ctx.shutdown();
      return { accepted: true };
    case 'setModel': {
      const model = ctx.modelRegistry.find(command.provider, command.model);
      if (!model) throw new Error('Requested model is not available.');
      if (!(await pi.setModel(model)))
        throw new Error('Model authentication is unavailable.');
      return { accepted: true };
    }
    case 'setThinking':
      pi.setThinkingLevel(command.level as never);
      return { accepted: true };
    case 'setSessionName':
      pi.setSessionName(command.name);
      return { accepted: true };
    case 'interaction.answer':
      if (!broker.answer(command.interactionId, command.answer))
        throw new Error(
          'Interaction is already resolved or the answer is invalid.',
        );
      return { accepted: true };
    case 'interaction.cancel':
      if (!broker.cancel(command.interactionId))
        throw new Error('Interaction is already resolved.');
      return { accepted: true };
  }
}

export interface RemoteControlRuntime {
  readonly runtimeId: string;
  readonly client: BridgeClient;
  readonly eventNormalizer: LiveEventNormalizer;
  readonly queueDrafts: QueueDraftStore;
  setContext(ctx: ExtensionContext): void;
  clearContext(ctx: ExtensionContext): void;
  isCurrent(ctx: ExtensionContext): boolean;
  setLiveState(state: RuntimeLiveState): void;
  snapshot(): RuntimeSnapshot;
}

export function createRemoteControlRuntime(
  pi: ExtensionAPI,
): RemoteControlRuntime | undefined {
  // This extension is globally loaded. A missing daemon is a normal offline
  // condition, not a reason to make Pi startup fail.
  const socketPath =
    process.env.PI_DASHBOARD_SOCKET ??
    path.join(os.homedir(), '.pi', 'agent', 'dashboard', 'bridge.sock');
  const runtimeId =
    process.env.PI_DASHBOARD_RUNTIME_ID || `runtime-${randomUUID()}`;
  const ownership = process.env.PI_DASHBOARD_RUNTIME_ID
    ? 'managed'
    : 'external';
  const broker = getInteractionBroker();
  const eventNormalizer = new LiveEventNormalizer();
  let context: ExtensionContext | undefined;
  let currentSessionId: string | undefined;
  let contextScope: string | undefined;
  let lastError: string | undefined;
  const queueDrafts = new QueueDraftStore();
  const unavailableSnapshot = (): RuntimeSnapshot => ({
    runtimeId,
    ownership,
    pid: process.pid,
    cwd: process.cwd(),
    liveState: 'idle',
    session: { id: 'unknown', entries: [] },
    pendingInteractions: broker.list().map(interactionSnapshot),
    queueDrafts: queueDrafts.list(),
    capabilities: RUNTIME_CAPABILITIES,
    extensionSurfaces: liveExtensionSurfaceHub.snapshot(),
    lastError,
  });
  let cachedSnapshot = unavailableSnapshot();
  const snapshotFrom = (ctx: ExtensionContext): RuntimeSnapshot => {
    const usage = ctx.getContextUsage();
    return {
      runtimeId,
      ownership,
      pid: process.pid,
      cwd: ctx.cwd,
      liveState: liveState(ctx, broker),
      session: sessionSnapshot(ctx),
      model: modelSnapshot(ctx),
      modelCatalog: modelCatalogSnapshot(ctx),
      thinkingLevels: thinkingLevelsSnapshot(),
      contextUsage: usage
        ? {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
          }
        : undefined,
      pendingInteractions: broker.list().map(interactionSnapshot),
      queueDrafts: queueDrafts.list(),
      capabilities: RUNTIME_CAPABILITIES,
      extensionSurfaces: liveExtensionSurfaceHub.snapshot(),
      lastError,
    };
  };
  const client = new BridgeClient({
    socketPath,
    token:
      process.env.PI_DASHBOARD_LAUNCH_TOKEN ?? process.env.PI_DASHBOARD_TOKEN,
    identityToken: process.env.PI_DASHBOARD_IDENTITY_TOKEN,
    runtimeId,
    broker,
    capabilities: RUNTIME_CAPABILITIES,
    commandScope: () => contextScope,
    liveSurfaces: liveExtensionSurfaceHub,
    onLiveSurfacesChanged: (surfaces) => {
      cachedSnapshot = { ...cachedSnapshot, extensionSurfaces: surfaces };
    },
    // Socket callbacks run outside Pi's extension event dispatch. Returning a
    // cache keeps reconnects from dereferencing a context that was invalidated
    // by session replacement or extension reload.
    snapshot: () => cachedSnapshot,
    handleCommand: async (command, capabilities) => {
      const commandContext = context;
      if (!commandContext) throw new Error('Pi session is not ready.');
      const commandSessionId = commandContext.sessionManager.getSessionId();
      const result = await dispatchDashboardCommand(
        pi,
        commandContext,
        broker,
        command,
        capabilities,
        queueDrafts,
      );
      // Queue mutations are dashboard-owned state, so acknowledge them only
      // after refreshing the cached snapshot. A session replacement that wins
      // the race must not publish the old draft set into the new session.
      if (
        isQueueDraftCommand(command) &&
        context === commandContext &&
        currentSessionId === commandSessionId
      ) {
        setContext(commandContext);
        client.sendEvent({
          type: 'runtime.stateChanged',
          state: liveState(commandContext, broker),
          snapshot: cachedSnapshot,
        });
      }
      return result;
    },
  });

  const setContext = (ctx: ExtensionContext) => {
    try {
      lastError = undefined;
      const nextScope = ctx.sessionManager.getSessionId();
      if (contextScope && contextScope !== nextScope) {
        broker.cancelScope(contextScope);
        eventNormalizer.reset();
      }
      queueDrafts.setSession(nextScope);
      const next = snapshotFrom(ctx);
      context = ctx;
      contextScope = nextScope;
      currentSessionId = next.session.id;
      cachedSnapshot = next;
    } catch (error) {
      queueDrafts.clear();
      if (contextScope) broker.cancelScope(contextScope);
      context = undefined;
      contextScope = undefined;
      currentSessionId = undefined;
      eventNormalizer.reset();
      lastError = error instanceof Error ? error.message : String(error);
      cachedSnapshot = unavailableSnapshot();
    }
  };
  const snapshot = () => cachedSnapshot;
  const setLiveState = (state: RuntimeLiveState) => {
    cachedSnapshot = { ...cachedSnapshot, liveState: state };
  };
  const isCurrent = (ctx: ExtensionContext) => {
    if (!currentSessionId) return false;
    try {
      return ctx.sessionManager.getSessionId() === currentSessionId;
    } catch {
      return false;
    }
  };
  const clearContext = (ctx: ExtensionContext) => {
    if (!isCurrent(ctx) && context !== ctx) return;
    try {
      broker.cancelScope(ctx.sessionManager.getSessionId());
    } catch {
      /* stale session contexts may no longer expose their manager */
    }
    if (contextScope) broker.cancelScope(contextScope);
    queueDrafts.setSession(undefined);
    queueDrafts.clear();
    context = undefined;
    contextScope = undefined;
    currentSessionId = undefined;
    eventNormalizer.reset();
    cachedSnapshot = unavailableSnapshot();
  };
  return {
    runtimeId,
    client,
    eventNormalizer,
    queueDrafts,
    setContext,
    clearContext,
    isCurrent,
    setLiveState,
    snapshot,
  };
}

export function flushQueueDrafts(
  runtime: RemoteControlRuntime,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mode: QueueDraftMode,
): boolean {
  if (!runtime.isCurrent(ctx)) return false;
  runtime.setContext(ctx);
  if (!runtime.isCurrent(ctx)) return false;
  const drafts = runtime.queueDrafts.take(mode);
  if (drafts.length === 0) return false;
  let failedAt = drafts.length;
  for (const [index, draft] of drafts.entries()) {
    try {
      pi.sendUserMessage(draft.text, {
        deliverAs: draft.mode,
      });
    } catch {
      failedAt = index;
      break;
    }
  }
  // A send may synchronously trigger a session replacement. Never restore an
  // old session's drafts into the replacement, and never reinstall its cache.
  if (failedAt < drafts.length && runtime.isCurrent(ctx))
    runtime.queueDrafts.restore(drafts.slice(failedAt));
  if (runtime.isCurrent(ctx)) {
    runtime.setContext(ctx);
    if (runtime.isCurrent(ctx))
      runtime.client.sendEvent({
        type: 'runtime.stateChanged',
        state: liveState(ctx, getInteractionBroker()),
        snapshot: runtime.snapshot(),
      });
  }
  return true;
}

function emitState(
  runtime: RemoteControlRuntime,
  ctx: ExtensionContext,
  forcedState?: RuntimeLiveState,
): void {
  if (!runtime.isCurrent(ctx)) return;
  runtime.setContext(ctx);
  if (!runtime.isCurrent(ctx)) return;
  const state = forcedState ?? liveState(ctx, getInteractionBroker());
  if (forcedState) runtime.setLiveState(forcedState);
  runtime.client.sendEvent({
    type: 'runtime.stateChanged',
    state,
    snapshot: runtime.snapshot(),
  });
}

export function emitAgentSettlement(
  runtime: RemoteControlRuntime,
  ctx: ExtensionContext,
): void {
  if (!isGenuineAgentSettlement()) {
    emitState(runtime, ctx, 'working');
    return;
  }
  emitState(runtime, ctx);
  if (!runtime.isCurrent(ctx)) return;
  runtime.client.sendEvent({
    type: 'agent.settled',
    sessionId: ctx.sessionManager.getSessionId(),
  });
}

type GenericEventAPI = {
  on(
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => void,
  ): void;
};
function onTransportEvent(
  pi: ExtensionAPI,
  event: string,
  handler: (event: unknown, ctx: ExtensionContext) => void,
): void {
  (pi as unknown as GenericEventAPI).on(event, handler);
}

export default defineExtension('remote-control', (pi) => {
  const runtime = createRemoteControlRuntime(pi);
  if (!runtime) return;
  const stopSteeringUpdates = pi.events.on(
    'steering-message:marked',
    (value) => {
      const update = eventRecord(value);
      const message = eventRecord(directValue(update, 'message'));
      const sessionId = directString(update, 'sessionId');
      if (!message || !sessionId) return;
      runtime.client.sendEvent({
        type: 'message.updated',
        sessionId,
        // Marker delivery may run after another message has become active, so
        // derive the steering update's identity independently from its exact
        // persisted timestamp instead of borrowing the active stream ID.
        message: new LiveEventNormalizer().normalizeMessage('updated', {
          message: { ...message, data: { deliveryMode: 'steer' } },
        }),
      });
    },
  );
  const onCurrentTransportEvent = (
    event: string,
    handler: (value: unknown, ctx: ExtensionContext) => void,
  ) =>
    onTransportEvent(pi, event, (value, ctx) => {
      if (!runtime.isCurrent(ctx)) return;
      runtime.setContext(ctx);
      if (runtime.isCurrent(ctx)) handler(value, ctx);
    });

  pi.on('session_start', (_event, ctx) => {
    runtime.setContext(ctx);
    if (!runtime.isCurrent(ctx)) return;
    runtime.client.start();
    runtime.client.sendEvent({
      type: 'session.snapshot',
      session: sessionSnapshot(ctx),
    });
    // Session replacement clears dashboard-owned drafts in setContext; publish
    // that empty/current set even when the bridge connection is reused.
    emitState(runtime, ctx);
  });
  pi.on('session_info_changed', (_event, ctx) => {
    runtime.setContext(ctx);
    if (!runtime.isCurrent(ctx)) return;
    runtime.client.sendEvent({
      type: 'session.changed',
      session: sessionSnapshot(ctx),
    });
  });
  pi.on('session_tree', (_event, ctx) => {
    runtime.setContext(ctx);
    if (!runtime.isCurrent(ctx)) return;
    runtime.client.sendEvent({
      type: 'session.snapshot',
      session: sessionSnapshot(ctx),
    });
  });
  pi.on('before_agent_start', (_event, ctx) => {
    if (!runtime.isCurrent(ctx)) return;
    runtime.setContext(ctx);
    if (!runtime.isCurrent(ctx)) return;
    runtime.setLiveState('working');
    runtime.client.sendEvent({
      type: 'runtime.stateChanged',
      state: 'working',
      snapshot: runtime.snapshot(),
    });
  });
  pi.on('agent_start', (_event, ctx) => emitState(runtime, ctx));
  pi.on('turn_end', (_event, ctx) => {
    flushQueueDrafts(runtime, pi, ctx, 'steer');
  });
  pi.on('agent_settled', (_event, ctx) => {
    emitAgentSettlement(runtime, ctx);
  });
  pi.on('agent_end', (_event, ctx) => {
    if (!flushQueueDrafts(runtime, pi, ctx, 'followUp'))
      emitState(runtime, ctx);
  });
  onCurrentTransportEvent('message_start', (event, ctx) => {
    if (!shouldForwardLiveMessage(event)) return;
    runtime.client.sendEvent({
      type: 'message.started',
      sessionId: ctx.sessionManager.getSessionId(),
      message: runtime.eventNormalizer.normalizeMessage('started', event),
    });
  });
  onCurrentTransportEvent('message_update', (event, ctx) => {
    if (!shouldForwardLiveMessage(event)) return;
    runtime.client.sendEvent({
      type: 'message.updated',
      sessionId: ctx.sessionManager.getSessionId(),
      message: runtime.eventNormalizer.normalizeMessage('updated', event),
    });
  });
  onCurrentTransportEvent('message_end', (event, ctx) => {
    if (!shouldForwardLiveMessage(event)) return;
    runtime.client.sendEvent({
      type: 'message.finished',
      sessionId: ctx.sessionManager.getSessionId(),
      message: runtime.eventNormalizer.normalizeMessage('finished', event),
    });
  });
  onCurrentTransportEvent('tool_execution_start', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'tool.started',
      sessionId: ctx.sessionManager.getSessionId(),
      tool: runtime.eventNormalizer.normalizeTool('started', event),
    }),
  );
  onCurrentTransportEvent('tool_execution_update', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'tool.updated',
      sessionId: ctx.sessionManager.getSessionId(),
      tool: runtime.eventNormalizer.normalizeTool('updated', event),
    }),
  );
  onCurrentTransportEvent('tool_execution_end', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'tool.finished',
      sessionId: ctx.sessionManager.getSessionId(),
      tool: runtime.eventNormalizer.normalizeTool('finished', event),
    }),
  );
  onCurrentTransportEvent('model_select', (_event, ctx) =>
    emitState(runtime, ctx),
  );
  onCurrentTransportEvent('thinking_level_select', (_event, ctx) =>
    emitState(runtime, ctx),
  );
  onCurrentTransportEvent('queue_update', (_event, ctx) =>
    emitState(runtime, ctx),
  );
  pi.on('session_shutdown', (event, ctx) => {
    stopSteeringUpdates();
    const tearsDownExtension =
      event.reason === 'quit' || event.reason === 'reload';
    const wasCurrent = runtime.isCurrent(ctx);
    if (tearsDownExtension && wasCurrent)
      runtime.client.sendEvent({
        type: 'runtime.goodbye',
        reason: event.reason,
      });
    runtime.clearContext(ctx);
    if (wasCurrent && !tearsDownExtension)
      runtime.client.sendEvent({
        type: 'runtime.stateChanged',
        state: 'idle',
        snapshot: runtime.snapshot(),
      });
    if (tearsDownExtension) runtime.client.stop();
  });
});
