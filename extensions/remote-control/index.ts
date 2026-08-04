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
  type NormalizedMessagePayload,
  type NormalizedToolPayload,
  PROTOCOL_VERSION,
  parseFrame,
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
import { defineExtension } from '../shared/runtime/extension';

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
] as const;
const RUNTIME_CAPABILITIES = createRuntimeCapabilitySnapshot(
  CONTRIBUTION_MANIFESTS,
  [
    ...askUserCapabilitySnapshot.capabilities,
    ...activityGroupsCapabilitySnapshot.capabilities,
  ],
);

type CommandHandler = (command: BridgeCommand) => Promise<unknown>;

type CommandInfo = ReturnType<ExtensionAPI['getCommands']>[number];
type EventRecord = Record<string, unknown>;

function eventRecord(value: unknown): EventRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as EventRecord)
    : {};
}

function withoutOpaqueData(event: BridgeEvent): BridgeEvent {
  if (event.type.startsWith('message.') && 'message' in event) {
    const message = event.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const { data: _data, ...canonical } = message as Record<string, unknown>;
      return { ...event, message: canonical };
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
      ctx.compact({ customInstructions: invocation.args.trim() || undefined });
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
              source: {
                type: 'base64' as const,
                mediaType: image.mediaType,
                data: readFileSync(image.path).toString('base64'),
              },
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
  handleCommand: CommandHandler;
  broker?: InteractionBroker;
  capabilities?: RuntimeCapabilitySnapshot;
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
  }> = [];
  private commandRunning = false;
  private readonly actionCommandIds = new Set<string>();
  private outboundQueue: Array<{
    socket: net.Socket;
    data: string;
    droppable: boolean;
  }> = [];
  private outboundBytes = 0;
  private writeBlocked = false;
  private unsubscribeBroker: (() => void) | undefined;

  constructor(private readonly options: BridgeClientOptions) {
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
    this.commandQueue = [];
    this.clearOutboundQueue();
    this.socket?.destroy();
    this.socket = undefined;
  }

  sendEvent(event: BridgeEvent): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
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
        ...(this.options.broker
          ? { pendingInteractions: interactions }
          : undefined),
      };
      const helloSent = this.sendEvent({
        type: 'runtime.hello',
        protocolVersion: PROTOCOL_VERSION,
        token: this.options.token,
        identityToken: this.options.identityToken,
        capabilities: { heartbeat: true, extensions: RUNTIME_CAPABILITIES },
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
    if (command.type === 'action.invoke') {
      const action = this.options.capabilities?.manifests
        .flatMap((manifest) => manifest.actions)
        .find((item) => item.id === command.actionId);
      if (!action?.idempotent) {
        if (this.actionCommandIds.has(command.id)) {
          this.sendAck(
            socket,
            command.id,
            false,
            'Duplicate semantic action command ID.',
            'duplicate-action-id',
          );
          return;
        }
        this.actionCommandIds.add(command.id);
      }
    }
    if (
      this.commandQueue.length + (this.commandRunning ? 1 : 0) >=
      BRIDGE_COMMAND_QUEUE_LIMIT
    ) {
      this.sendAck(socket, command.id, false, 'Command queue is full.');
      return;
    }
    this.commandQueue.push({ command, socket });
    this.pumpCommands();
  }

  private pumpCommands(): void {
    if (this.commandRunning) return;
    const item = this.commandQueue.shift();
    if (!item) return;
    this.commandRunning = true;
    void (async () => {
      try {
        // Commands received on a replaced generation are abandoned rather than
        // replayed. Replaying could duplicate a prompt after a daemon retry.
        if (item.socket !== this.socket || item.socket.destroyed) return;
        try {
          const result = await this.options.handleCommand(item.command);
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
      } finally {
        this.commandRunning = false;
        this.pumpCommands();
      }
    })();
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
  return {
    id: manager.getSessionId(),
    file: manager.getSessionFile(),
    name: manager.getSessionName(),
    title: deriveSessionTitle(entries),
    cwd: manager.getCwd(),
    leafId: manager.getLeafId() ?? undefined,
    entries: (jsonSafe(entries) as readonly unknown[] | null) ?? [],
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
): Promise<unknown> {
  const invocation: ActionInvocation = parseActionInvocation(command);
  const action = findActionDescriptor(
    CONTRIBUTION_MANIFESTS,
    invocation.actionId,
  );
  if (!action)
    throw Object.assign(
      new Error(`Unknown dashboard action: ${invocation.actionId}`),
      { code: 'unknown-action' },
    );
  const available = isActionAvailable(action, RUNTIME_CAPABILITIES, {
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
  parseActionInput(action, invocation.input);
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
): Promise<unknown> {
  if (command.type === 'action.invoke')
    return dispatchSemanticAction(ctx, broker, command);
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
  const unavailableSnapshot = (): RuntimeSnapshot => ({
    runtimeId,
    ownership,
    pid: process.pid,
    cwd: process.cwd(),
    liveState: 'idle',
    session: { id: 'unknown', entries: [] },
    pendingInteractions: broker.list().map(interactionSnapshot),
    capabilities: RUNTIME_CAPABILITIES,
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
      contextUsage: usage
        ? {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
          }
        : undefined,
      pendingInteractions: broker.list().map(interactionSnapshot),
      capabilities: RUNTIME_CAPABILITIES,
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
    // Socket callbacks run outside Pi's extension event dispatch. Returning a
    // cache keeps reconnects from dereferencing a context that was invalidated
    // by session replacement or extension reload.
    snapshot: () => cachedSnapshot,
    handleCommand: async (command) => {
      if (!context) throw new Error('Pi session is not ready.');
      return dispatchDashboardCommand(pi, context, broker, command);
    },
  });

  const setContext = (ctx: ExtensionContext) => {
    try {
      lastError = undefined;
      const next = snapshotFrom(ctx);
      const nextScope = ctx.sessionManager.getSessionId();
      if (contextScope && contextScope !== nextScope) {
        broker.cancelScope(contextScope);
        eventNormalizer.reset();
      }
      context = ctx;
      contextScope = nextScope;
      currentSessionId = next.session.id;
      cachedSnapshot = next;
    } catch (error) {
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
    setContext,
    clearContext,
    isCurrent,
    setLiveState,
    snapshot,
  };
}

function emitState(runtime: RemoteControlRuntime, ctx: ExtensionContext): void {
  if (!runtime.isCurrent(ctx)) return;
  runtime.setContext(ctx);
  if (!runtime.isCurrent(ctx)) return;
  runtime.client.sendEvent({
    type: 'runtime.stateChanged',
    state: liveState(ctx, getInteractionBroker()),
    snapshot: runtime.snapshot(),
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
  });
  pi.on('session_info_changed', (_event, ctx) => {
    runtime.setContext(ctx);
    if (!runtime.isCurrent(ctx)) return;
    runtime.client.sendEvent({
      type: 'session.changed',
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
  pi.on('agent_settled', (_event, ctx) => {
    emitState(runtime, ctx);
    if (!runtime.isCurrent(ctx)) return;
    runtime.client.sendEvent({
      type: 'agent.settled',
      sessionId: ctx.sessionManager.getSessionId(),
    });
  });
  pi.on('agent_end', (_event, ctx) => emitState(runtime, ctx));
  onCurrentTransportEvent('message_start', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'message.started',
      sessionId: ctx.sessionManager.getSessionId(),
      message: runtime.eventNormalizer.normalizeMessage('started', event),
    }),
  );
  onCurrentTransportEvent('message_update', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'message.updated',
      sessionId: ctx.sessionManager.getSessionId(),
      message: runtime.eventNormalizer.normalizeMessage('updated', event),
    }),
  );
  onCurrentTransportEvent('message_end', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'message.finished',
      sessionId: ctx.sessionManager.getSessionId(),
      message: runtime.eventNormalizer.normalizeMessage('finished', event),
    }),
  );
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
    const tearsDownExtension =
      event.reason === 'quit' || event.reason === 'reload';
    if (tearsDownExtension && runtime.isCurrent(ctx))
      runtime.client.sendEvent({
        type: 'runtime.goodbye',
        reason: event.reason,
      });
    runtime.clearContext(ctx);
    if (tearsDownExtension) runtime.client.stop();
  });
});
