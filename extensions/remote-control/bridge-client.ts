import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { NonIdempotentActionIdGuard } from '@pi-dashboard/extension-contributions';
import {
  type BridgeCommand,
  type BridgeEvent,
  type DelegateTranscriptEntry,
  MAX_QUEUE_DRAFTS,
  PROTOCOL_VERSION,
  parseFrame,
  type RuntimeCapabilitySnapshot,
  type RuntimeExtensionSurface,
  type RuntimeSnapshot,
  serializeFrame,
} from '@pi-dashboard/protocol/pi-runtime-protocol';
import { aggregateRuntimeCapabilities } from '../shared/runtime/capability-registry';
import type { CommandHandler } from './command-dispatcher';
import { jsonSafe } from './json-safe';
import { withoutOpaqueData } from './live-event-normalizer';
import { isQueueDraftCommand } from './queue-draft-store';

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const MAX_LINE_BYTES = 512 * 1024;
export const BRIDGE_COMMAND_QUEUE_LIMIT = 64;
const BRIDGE_WRITE_QUEUE_LIMIT = 128;
const BRIDGE_WRITE_QUEUE_BYTES = 1 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 5_000;
const COMPLETED_SEMANTIC_COMMAND_LIMIT = 128;
const BRIDGE_REQUEST_TIMEOUT_MS = 20_000;
const BRIDGE_CAPABILITY_TIMEOUT_MS = 1_000;

type DelegateTranscriptSurfaceEntry = {
  key: string;
  lineageId: string;
  runId: string;
  entry: DelegateTranscriptEntry;
};

function delegateTranscriptEntries(
  surfaces: readonly RuntimeExtensionSurface[],
): Map<string, DelegateTranscriptSurfaceEntry> {
  const entries = new Map<string, DelegateTranscriptSurfaceEntry>();
  for (const surface of surfaces) {
    if (surface.rendererId !== 'delegate.status') continue;
    const model = surface.viewModel;
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
    const statuses = (model as { statuses?: unknown }).statuses;
    if (!Array.isArray(statuses)) continue;
    for (const status of statuses) {
      if (!status || typeof status !== 'object' || Array.isArray(status))
        continue;
      const candidate = status as {
        lineageId?: unknown;
        runId?: unknown;
        state?: unknown;
        pauseState?: unknown;
        /** Hosted delegates have their own runtime/session feed authority. */
        sessionId?: unknown;
        transcript?: unknown;
      };
      if (
        typeof candidate.lineageId !== 'string' ||
        typeof candidate.runId !== 'string' ||
        candidate.sessionId !== undefined ||
        !(
          candidate.state === 'queued' ||
          candidate.state === 'running' ||
          candidate.pauseState === 'pausing' ||
          candidate.pauseState === 'paused'
        ) ||
        !Array.isArray(candidate.transcript)
      )
        continue;
      for (const entry of candidate.transcript) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          continue;
        const value = entry as DelegateTranscriptEntry;
        if (typeof value.id !== 'string') continue;
        const key = `${candidate.lineageId}:${candidate.runId}:${value.run ?? 1}:${value.id}`;
        entries.set(key, {
          key,
          lineageId: candidate.lineageId,
          runId: candidate.runId,
          entry: value,
        });
      }
    }
  }
  return entries;
}

function compactDelegateSurfaces(
  surfaces: readonly RuntimeExtensionSurface[] | undefined,
): readonly RuntimeExtensionSurface[] | undefined {
  return surfaces?.map((surface) => {
    if (surface.rendererId !== 'delegate.status') return surface;
    const model = surface.viewModel;
    if (!model || typeof model !== 'object' || Array.isArray(model))
      return surface;
    const statuses = (model as { statuses?: unknown }).statuses;
    if (!Array.isArray(statuses)) return surface;
    return {
      ...surface,
      viewModel: {
        ...model,
        statuses: statuses.map((status) => {
          if (!status || typeof status !== 'object' || Array.isArray(status))
            return status;
          const {
            transcript: _transcript,
            result,
            activity,
            ...metadata
          } = status as {
            transcript?: unknown;
            result?: unknown;
            activity?: unknown;
            [key: string]: unknown;
          };
          const compactResult =
            result && typeof result === 'object' && !Array.isArray(result)
              ? (() => {
                  const { value: _value, ...rest } = result as Record<
                    string,
                    unknown
                  >;
                  return {
                    ...rest,
                    ...(Object.hasOwn(result, 'value')
                      ? { valueOmitted: true }
                      : {}),
                  };
                })()
              : result;
          const compactActivity =
            activity && typeof activity === 'object' && !Array.isArray(activity)
              ? (() => {
                  const { latestText: _latestText, ...rest } =
                    activity as Record<string, unknown>;
                  return rest;
                })()
              : activity;
          return {
            ...metadata,
            ...(compactActivity === undefined
              ? {}
              : { activity: compactActivity }),
            ...(compactResult === undefined ? {} : { result: compactResult }),
          };
        }),
      },
    } as RuntimeExtensionSurface;
  });
}

type SemanticCommand = Extract<
  BridgeCommand,
  { type: 'prompt' | 'steer' | 'followUp' }
>;
type CommandExecution =
  | { status: 'success'; result: unknown }
  | { status: 'failed'; error: string; code?: string }
  | { status: 'stale' };
type SemanticCommandRecord = {
  fingerprint: string;
  promise: Promise<CommandExecution>;
  resolve: (outcome: CommandExecution) => void;
};

function isSemanticCommand(command: BridgeCommand): command is SemanticCommand {
  return (
    command.type === 'prompt' ||
    command.type === 'steer' ||
    command.type === 'followUp'
  );
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
  capabilities?: RuntimeCapabilitySnapshot;
  liveSurfaces?: {
    subscribe(
      listener: (surfaces: readonly RuntimeExtensionSurface[]) => void,
    ): () => void;
    snapshot?: () => readonly RuntimeExtensionSurface[];
  };
  onLiveSurfacesChanged?: (
    surfaces: readonly RuntimeExtensionSurface[],
  ) => void;
}

/** Reconnecting JSONL client. It never queues browser commands while offline. */
export function isDroppableBridgeEvent(event: BridgeEvent): boolean {
  const toolArgumentDelta =
    event.type === 'tool.updated' &&
    typeof event.tool === 'object' &&
    event.tool !== null &&
    typeof (event.tool as { argumentDelta?: unknown }).argumentDelta ===
      'string';
  return (
    event.type === 'message.updated' ||
    (event.type === 'tool.updated' && !toolArgumentDelta) ||
    (event.type === 'delegate.transcript.updated' &&
      event.entry.status === 'running')
  );
}

export class BridgeClient {
  private socket: net.Socket | undefined;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = RECONNECT_MIN_MS;
  private buffer = '';
  private seq = 0;
  private usageRequestsAvailable = false;
  private readonly usageReadyWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    removeAbort?: () => void;
  }>();
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      removeAbort?: () => void;
    }
  >();
  private commandQueue: Array<{
    command: BridgeCommand;
    socket: net.Socket;
    scope?: string;
  }> = [];
  private commandRunning = false;
  private queueDraftCommandsRunning = 0;
  private readonly actionCommandIds = new NonIdempotentActionIdGuard();
  /** Successful prompt-family commands survive socket churn in this client. */
  private readonly completedSemanticCommands = new Map<
    string,
    { fingerprint: string; result: unknown }
  >();
  /** Captured scope is part of the key, so replacement sessions cannot replay. */
  private readonly semanticCommandsInFlight = new Map<
    string,
    SemanticCommandRecord
  >();
  private outboundQueue: Array<{
    socket: net.Socket;
    data: string;
    droppable: boolean;
  }> = [];
  private outboundBytes = 0;
  private writeBlocked = false;
  private unsubscribeLiveSurfaces: (() => void) | undefined;
  private liveSurfaces: BridgeClientOptions['liveSurfaces'];
  private delegateTranscriptEntries = new Map<
    string,
    DelegateTranscriptSurfaceEntry
  >();
  private compactDelegateSurfaces: readonly RuntimeExtensionSurface[] = [];

  constructor(private readonly options: BridgeClientOptions) {
    this.bindServices(options.liveSurfaces);
  }

  private resolveCapabilities(): RuntimeCapabilitySnapshot {
    return (
      this.options.capabilities ??
      aggregateRuntimeCapabilities(this.options.commandScope?.() ?? 'default')
    );
  }

  /** Rebind transport observers when Pi replaces the active session scope. */
  bindServices(liveSurfaces: BridgeClientOptions['liveSurfaces']): void {
    this.unsubscribeLiveSurfaces?.();
    this.unsubscribeLiveSurfaces = undefined;
    this.unsubscribeLiveSurfaces = undefined;
    this.liveSurfaces = liveSurfaces;
    const currentSurfaces = liveSurfaces?.snapshot?.() ?? [];
    this.delegateTranscriptEntries = delegateTranscriptEntries(currentSurfaces);
    this.compactDelegateSurfaces =
      compactDelegateSurfaces(currentSurfaces) ?? [];
    this.unsubscribeLiveSurfaces = liveSurfaces?.subscribe((surfaces) => {
      try {
        const current = this.options.snapshot();
        const nextEntries = delegateTranscriptEntries(surfaces);
        const changedEntries = [...nextEntries.values()].filter((next) => {
          const previous = this.delegateTranscriptEntries.get(next.key);
          return (
            !previous ||
            JSON.stringify(previous.entry) !== JSON.stringify(next.entry)
          );
        });
        const compactSurfaces = compactDelegateSurfaces(surfaces) ?? [];
        const metadataChanged =
          JSON.stringify(this.compactDelegateSurfaces) !==
          JSON.stringify(compactSurfaces);
        // Update the reconnect authority before publishing either frame. The
        // compact metadata patch must establish new runs before their transcript
        // upserts arrive at the runtime reducer.
        this.delegateTranscriptEntries = nextEntries;
        this.compactDelegateSurfaces = compactSurfaces;
        this.options.onLiveSurfacesChanged?.(surfaces);
        if (metadataChanged)
          this.sendEvent({
            type: 'runtime.stateChanged',
            state: current.liveState,
            snapshot: { extensionSurfaces: compactSurfaces },
          });
        for (const next of changedEntries) {
          this.sendEvent({
            type: 'delegate.transcript.updated',
            sessionId: current.session.id,
            lineageId: next.lineageId,
            runId: next.runId,
            entry: next.entry,
          });
        }
      } catch {
        // A surface publisher must not make a Pi mutation fail because the
        // bridge is offline or a stale cached snapshot is unavailable.
      }
    });
  }

  start(): void {
    this.stopped = false;
    this.bindServices(this.liveSurfaces);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    this.unsubscribeLiveSurfaces?.();
    this.unsubscribeLiveSurfaces = undefined;
    for (const item of this.commandQueue) this.discardSemanticCommand(item);
    this.commandQueue = [];
    this.resolveInFlightSemanticCommandsAsStale();
    this.completedSemanticCommands.clear();
    this.usageRequestsAvailable = false;
    this.rejectUsageReadyWaiters(new Error('Dashboard bridge stopped.'));
    this.rejectPendingRequests(new Error('Dashboard bridge stopped.'));
    this.clearOutboundQueue();
    this.socket?.destroy();
    this.socket = undefined;
  }

  async requestUsage(force = false, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Dashboard usage request aborted.');
    const socket = await this.connectedSocket(signal);
    await this.waitForUsageBroker(signal);
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const finish = () => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return undefined;
        this.pendingRequests.delete(id);
        clearTimeout(pending.timer);
        pending.removeAbort?.();
        return pending;
      };
      const timer = setTimeout(() => {
        const pending = finish();
        pending?.reject(new Error('Dashboard usage request timed out.'));
      }, BRIDGE_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => {
        const pending = finish();
        pending?.reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('Dashboard usage request aborted.'),
        );
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
        ...(signal
          ? {
              removeAbort: () => signal.removeEventListener('abort', onAbort),
            }
          : {}),
      });
      try {
        socket.write(
          serializeFrame({
            kind: 'request',
            request: { id, type: 'usage.read', ...(force ? { force } : {}) },
          }),
        );
      } catch (error) {
        const pending = finish();
        pending?.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  sendEvent(event: BridgeEvent): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
    // The daemon requires runtime.hello to be the first frame. The connect
    // callback builds that authoritative snapshot from the latest context, so
    // events attempted before the handshake are safely covered by hello.
    if (socket.connecting) return false;
    const wireEvent: BridgeEvent = withoutOpaqueData(event);
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
    const droppable = isDroppableBridgeEvent(wireEvent);
    return this.enqueueOutbound(socket, data, droppable);
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
      snapshot = {
        ...snapshot,
        // One effective capability snapshot drives hello, runtime snapshot,
        // duplicate protection, and semantic dispatch.
        capabilities: this.resolveCapabilities(),
      };
      const fullSurfaces =
        this.liveSurfaces?.snapshot?.() ?? snapshot.extensionSurfaces;
      const compactSurfaces = compactDelegateSurfaces(fullSurfaces);
      this.compactDelegateSurfaces = compactSurfaces ?? [];
      const helloSent = this.sendEvent({
        type: 'runtime.hello',
        protocolVersion: PROTOCOL_VERSION,
        token: this.options.token,
        identityToken: this.options.identityToken,
        capabilities: {
          heartbeat: true,
          extensions: this.resolveCapabilities(),
        },
        snapshot: {
          ...snapshot,
          ...(compactSurfaces === undefined
            ? {}
            : { extensionSurfaces: compactSurfaces }),
        },
      });
      if (!helloSent) return;
      // Hello carries compact row metadata. Replay current bounded active
      // entries after it so the registry rebuilds transcript authority without
      // risking an oversized hello frame.
      const replayEntries = delegateTranscriptEntries(fullSurfaces ?? []);
      this.delegateTranscriptEntries = replayEntries;
      for (const entry of replayEntries.values())
        this.sendEvent({
          type: 'delegate.transcript.updated',
          sessionId: snapshot.session.id,
          lineageId: entry.lineageId,
          runId: entry.runId,
          entry: entry.entry,
        });
      this.startHeartbeat(socket);
    });
    socket.on('data', (chunk: string) => this.onData(socket, chunk));
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.stopHeartbeat();
      const abandoned = this.commandQueue.filter(
        (item) => item.socket === socket,
      );
      this.commandQueue = this.commandQueue.filter(
        (item) => item.socket !== socket,
      );
      for (const item of abandoned) this.discardSemanticCommand(item);
      this.usageRequestsAvailable = false;
      this.rejectUsageReadyWaiters(
        new Error('Dashboard usage broker disconnected.'),
      );
      this.rejectPendingRequests(new Error('Dashboard bridge disconnected.'));
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
          else if (frame.kind === 'ready') {
            if (frame.capabilities.usageRead) {
              this.usageRequestsAvailable = true;
              for (const waiter of this.usageReadyWaiters) {
                clearTimeout(waiter.timer);
                waiter.removeAbort?.();
                waiter.resolve();
              }
              this.usageReadyWaiters.clear();
            }
          } else if (frame.kind === 'ack') {
            const pending = this.pendingRequests.get(frame.id);
            if (pending) {
              this.pendingRequests.delete(frame.id);
              clearTimeout(pending.timer);
              pending.removeAbort?.();
              if (frame.ok) pending.resolve(frame.result);
              else pending.reject(new Error(frame.error));
            }
          }
        } catch {
          // Malformed browser/daemon data is ignored; the socket remains
          // usable for the next bounded frame.
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private connectedSocket(signal?: AbortSignal): Promise<net.Socket> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error('Dashboard bridge is offline.'));
    if (!socket.connecting) return Promise.resolve(socket);
    return new Promise<net.Socket>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else if (socket !== this.socket || socket.destroyed)
          reject(new Error('Dashboard bridge connection was replaced.'));
        else resolve(socket);
      };
      const onConnect = () => finish();
      const onClose = () => finish(new Error('Dashboard bridge is offline.'));
      const onAbort = () =>
        finish(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('Dashboard bridge connection aborted.'),
        );
      const timer = setTimeout(
        () => finish(new Error('Dashboard bridge connection timed out.')),
        BRIDGE_REQUEST_TIMEOUT_MS,
      );
      timer.unref?.();
      socket.once('connect', onConnect);
      socket.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private waitForUsageBroker(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Dashboard usage broker wait aborted.'),
      );
    if (this.usageRequestsAvailable) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let waiter: {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
        removeAbort?: () => void;
      };
      const finish = (error?: Error) => {
        this.usageReadyWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.removeAbort?.();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () =>
        finish(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('Dashboard usage broker wait aborted.'),
        );
      waiter = {
        resolve: () => finish(),
        reject: (error) => finish(error),
        timer: setTimeout(
          () =>
            finish(
              new Error('Dashboard daemon does not advertise usage reads.'),
            ),
          BRIDGE_CAPABILITY_TIMEOUT_MS,
        ),
        ...(signal
          ? {
              removeAbort: () => signal.removeEventListener('abort', onAbort),
            }
          : {}),
      };
      waiter.timer.unref?.();
      this.usageReadyWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private rejectUsageReadyWaiters(error: Error): void {
    for (const waiter of this.usageReadyWaiters) {
      clearTimeout(waiter.timer);
      waiter.removeAbort?.();
      waiter.reject(error);
    }
    this.usageReadyWaiters.clear();
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private enqueue(command: BridgeCommand, socket: net.Socket): void {
    const item = {
      command,
      socket,
      scope: this.options.commandScope?.(),
    };
    // Completed and in-flight prompt-family duplicates are checked before
    // queue admission so an ACK resend cannot be rejected by unrelated load.
    if (this.handleSemanticDuplicate(item)) return;
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
      const action = this.resolveCapabilities()
        .manifests.flatMap((manifest) => manifest.actions)
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
    if (isSemanticCommand(command)) this.reserveSemanticCommand(item);
    this.commandQueue.push(item);
    this.pumpCommands();
  }

  private semanticCommandKey(command: SemanticCommand, scope?: string): string {
    return JSON.stringify([scope, command.id]);
  }

  private semanticCommandFingerprint(command: SemanticCommand): string {
    return JSON.stringify(command);
  }

  private handleSemanticDuplicate(item: {
    command: BridgeCommand;
    socket: net.Socket;
    scope?: string;
  }): boolean {
    if (!isSemanticCommand(item.command)) return false;
    const key = this.semanticCommandKey(item.command, item.scope);
    const fingerprint = this.semanticCommandFingerprint(item.command);
    const completed = this.completedSemanticCommands.get(key);
    if (completed) {
      // Refresh the bounded LRU entry when a valid resend arrives.
      this.completedSemanticCommands.delete(key);
      this.completedSemanticCommands.set(key, completed);
      if (completed.fingerprint !== fingerprint) {
        this.sendAck(
          item.socket,
          item.command.id,
          false,
          'A command ID was already used with a different payload.',
          'duplicate-command-id',
        );
      } else {
        this.sendAck(item.socket, item.command.id, true, completed.result);
      }
      return true;
    }
    const inFlight = this.semanticCommandsInFlight.get(key);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        this.sendAck(
          item.socket,
          item.command.id,
          false,
          'A command ID is already in flight with a different payload.',
          'duplicate-command-id',
        );
      } else {
        void inFlight.promise.then((outcome) =>
          this.sendSemanticExecutionAck(item, outcome),
        );
      }
      return true;
    }
    return false;
  }

  private reserveSemanticCommand(item: {
    command: BridgeCommand;
    socket: net.Socket;
    scope?: string;
  }): void {
    if (!isSemanticCommand(item.command)) return;
    const key = this.semanticCommandKey(item.command, item.scope);
    let resolve!: (outcome: CommandExecution) => void;
    const promise = new Promise<CommandExecution>((complete) => {
      resolve = (outcome) => complete(outcome);
    });
    this.semanticCommandsInFlight.set(key, {
      fingerprint: this.semanticCommandFingerprint(item.command),
      promise,
      resolve,
    });
  }

  private discardSemanticCommand(item: {
    command: BridgeCommand;
    scope?: string;
  }): void {
    if (!isSemanticCommand(item.command)) return;
    const key = this.semanticCommandKey(item.command, item.scope);
    const record = this.semanticCommandsInFlight.get(key);
    if (!record) return;
    record.resolve({ status: 'stale' });
    this.semanticCommandsInFlight.delete(key);
  }

  private resolveInFlightSemanticCommandsAsStale(): void {
    for (const record of this.semanticCommandsInFlight.values())
      record.resolve({ status: 'stale' });
    this.semanticCommandsInFlight.clear();
  }

  private completeSemanticCommand(
    item: {
      command: BridgeCommand;
      socket: net.Socket;
      scope?: string;
    },
    outcome: CommandExecution,
  ): void {
    if (!isSemanticCommand(item.command)) return;
    const key = this.semanticCommandKey(item.command, item.scope);
    const record = this.semanticCommandsInFlight.get(key);
    if (!record) return;
    record.resolve(outcome);
    this.semanticCommandsInFlight.delete(key);
    // A command that completed after a session replacement belongs only to the
    // old captured scope. Do not retain it as a replay for the new session.
    if (
      outcome.status === 'success' &&
      item.scope === this.options.commandScope?.()
    ) {
      this.completedSemanticCommands.delete(key);
      this.completedSemanticCommands.set(key, {
        fingerprint: record.fingerprint,
        result: outcome.result,
      });
      while (
        this.completedSemanticCommands.size > COMPLETED_SEMANTIC_COMMAND_LIMIT
      ) {
        const oldest = this.completedSemanticCommands.keys().next().value;
        if (oldest === undefined) break;
        this.completedSemanticCommands.delete(oldest);
      }
    }
  }

  private sendSemanticExecutionAck(
    item: { command: BridgeCommand; socket: net.Socket },
    outcome: CommandExecution,
  ): void {
    if (outcome.status === 'success')
      this.sendAck(item.socket, item.command.id, true, outcome.result);
    else if (outcome.status === 'failed')
      this.sendAck(
        item.socket,
        item.command.id,
        false,
        outcome.error,
        outcome.code,
      );
    else
      this.sendAck(
        item.socket,
        item.command.id,
        false,
        'Command belongs to a replaced session.',
        'stale-session',
      );
  }

  private async executeCommand(item: {
    command: BridgeCommand;
    socket: net.Socket;
    scope?: string;
  }): Promise<CommandExecution> {
    // Commands received on a replaced generation are abandoned rather than
    // replayed. Replaying could duplicate a prompt after a daemon retry.
    if (item.socket !== this.socket || item.socket.destroyed)
      return { status: 'stale' };
    if (item.scope !== this.options.commandScope?.()) {
      const outcome: CommandExecution = { status: 'stale' };
      this.sendSemanticExecutionAck(item, outcome);
      return outcome;
    }
    try {
      const result = await this.options.handleCommand(
        item.command,
        this.resolveCapabilities(),
      );
      const outcome: CommandExecution = { status: 'success', result };
      this.sendAck(item.socket, item.command.id, true, result);
      return outcome;
    } catch (error) {
      const outcome: CommandExecution = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ...(error && typeof error === 'object' && 'code' in error
          ? { code: String((error as { code: unknown }).code) }
          : {}),
      };
      this.sendSemanticExecutionAck(item, outcome);
      return outcome;
    }
  }

  private pumpCommands(): void {
    if (this.commandRunning) return;
    const item = this.commandQueue.shift();
    if (!item) return;
    this.commandRunning = true;
    void this.executeCommand(item)
      .then((outcome) => this.completeSemanticCommand(item, outcome))
      .finally(() => {
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
      // State events are replayable on reconnect but cannot be
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
        const current = this.options.snapshot();
        this.sendEvent({
          type: 'runtime.heartbeat',
          state: current.liveState,
          snapshot: { online: true, lastSeenAt: Date.now() },
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
