import net from 'node:net';
import { NonIdempotentActionIdGuard } from '@pi-dashboard/extension-contributions';
import {
  type BridgeCommand,
  type BridgeEvent,
  MAX_QUEUE_DRAFTS,
  PROTOCOL_VERSION,
  parseFrame,
  type RuntimeCapabilitySnapshot,
  type RuntimeExtensionSurface,
  type RuntimeSnapshot,
  serializeFrame,
} from '../../packages/dashboard-protocol/src/pi-runtime-protocol';
import type { InteractionBroker } from '../ask-user/broker';
import type { CommandHandler } from './command-dispatcher';
import { withoutOpaqueData } from './live-event-normalizer';
import { isQueueDraftCommand } from './queue-draft-store';
import {
  interactionSnapshot,
  jsonSafe,
  RUNTIME_CAPABILITIES,
} from './runtime-snapshot-adapter';

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const MAX_LINE_BYTES = 512 * 1024;
export const BRIDGE_COMMAND_QUEUE_LIMIT = 64;
const BRIDGE_WRITE_QUEUE_LIMIT = 128;
const BRIDGE_WRITE_QUEUE_BYTES = 1 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 5_000;

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
  private broker: InteractionBroker | undefined;
  private liveSurfaces: BridgeClientOptions['liveSurfaces'];

  constructor(private readonly options: BridgeClientOptions) {
    this.effectiveCapabilities = options.capabilities ?? RUNTIME_CAPABILITIES;
    this.bindServices(options.broker, options.liveSurfaces);
  }

  /** Rebind transport observers when Pi replaces the active session scope. */
  bindServices(
    broker: InteractionBroker | undefined,
    liveSurfaces: BridgeClientOptions['liveSurfaces'],
  ): void {
    this.unsubscribeBroker?.();
    this.unsubscribeLiveSurfaces?.();
    this.unsubscribeBroker = undefined;
    this.unsubscribeLiveSurfaces = undefined;
    this.broker = broker;
    this.liveSurfaces = liveSurfaces;
    this.unsubscribeBroker = broker?.subscribe((event) => {
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
    this.unsubscribeLiveSurfaces = liveSurfaces?.subscribe((surfaces) => {
      try {
        this.options.onLiveSurfacesChanged?.(surfaces);
        const current = this.options.snapshot();
        this.sendEvent({
          type: 'runtime.stateChanged',
          state: current.liveState,
          snapshot: { extensionSurfaces: surfaces },
        });
      } catch {
        // A surface publisher must not make a Pi mutation fail because the
        // bridge is offline or a stale cached snapshot is unavailable.
      }
    });
  }

  start(): void {
    this.stopped = false;
    this.bindServices(this.broker, this.liveSurfaces);
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
      const interactions = this.broker?.list().map(interactionSnapshot) ?? [];
      snapshot = {
        ...snapshot,
        // One effective capability snapshot drives hello, runtime snapshot,
        // duplicate protection, and semantic dispatch.
        capabilities: this.effectiveCapabilities,
        ...(this.broker ? { pendingInteractions: interactions } : undefined),
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
    if (item.scope !== this.options.commandScope?.()) {
      this.sendAck(
        item.socket,
        item.command.id,
        false,
        'Command belongs to a replaced session.',
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
