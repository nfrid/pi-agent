import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { Duplex, type DuplexOptions } from 'node:stream';
import type { PiSessionHandle } from '@earendil-works/pi-client';
import { PiClient, PiSessionOwnershipError } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';
import type {
  AgentRuntimeProvider,
  RuntimeBinding,
  RuntimeCommand,
  RuntimeLocation,
  RuntimeProviderEvent,
  RuntimeSnapshot,
  RuntimeStartInput,
  SessionSnapshot,
} from '@pi-dashboard/protocol';
import {
  type BridgeCommand,
  type BridgeEvent,
  parseFrame,
  serializeFrame,
} from '@pi-dashboard/protocol';
import type { RuntimeRegistry } from './runtime-registry.js';
import type { TmuxRuntimeProvider } from './tmux.js';

const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_COMMAND_QUEUE = 64;
const HEARTBEAT_MS = 10_000;
const MAX_TRANSCRIPT_ITEMS = 256;
const MAX_TRANSCRIPT_BYTES = 384 * 1024;

type ClientLike = Pick<
  PiClient,
  | 'dispose'
  | 'onConnectionStateChange'
  | 'snapshot'
  | 'connect'
  | 'createSession'
  | 'acquireSession'
>;

type LeaseLike = PiSessionHandle;

type NativeFailure = Error & { ownershipEstablished?: boolean };

/**
 * PiClient has no dashboard protocol knowledge. This bounded in-process
 * socket is the compatibility seam: RuntimeRegistry remains authoritative
 * while Pi session snapshots remain authoritative on the native side.
 */
class VirtualBridgeSocket extends Duplex {
  private readonly lines = new Map<number, string>();
  private input = '';
  private nextRequest = 0;
  private readonly handler: (line: string) => Promise<void>;

  constructor(handler: (line: string) => Promise<void>) {
    super({ decodeStrings: false } as DuplexOptions);
    this.handler = handler;
  }

  _read(): void {}

  _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.input +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    if (Buffer.byteLength(this.input) > MAX_COMMAND_BYTES) {
      callback(new Error('Virtual bridge command buffer exceeded its bound.'));
      this.destroy();
      return;
    }
    const completeLines: string[] = [];
    let newline = this.input.indexOf('\n');
    while (newline >= 0) {
      completeLines.push(this.input.slice(0, newline).trim());
      this.input = this.input.slice(newline + 1);
      newline = this.input.indexOf('\n');
    }
    if (completeLines.length === 0) {
      callback();
      return;
    }
    void (async () => {
      for (const line of completeLines) {
        if (!line) continue;
        if (this.lines.size >= MAX_COMMAND_QUEUE)
          throw new Error('Virtual bridge command queue is full.');
        const request = ++this.nextRequest;
        this.lines.set(request, line);
        try {
          await this.handler(line);
        } finally {
          this.lines.delete(request);
        }
      }
    })().then(
      () => callback(),
      (error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  send(
    frame:
      | { kind: 'event'; event: BridgeEvent; seq: number }
      | {
          kind: 'ack';
          id: string;
          ok: boolean;
          result?: unknown;
          error?: string;
          code?: string;
        },
  ): void {
    if (this.destroyed) return;
    this.push(serializeFrame(frame));
  }
}

function nativeFailure(
  error: unknown,
  ownershipEstablished: boolean,
): NativeFailure {
  const result = (
    error instanceof Error ? error : new Error(String(error))
  ) as NativeFailure;
  result.ownershipEstablished = ownershipEstablished;
  return result;
}

function modelRef(
  model: RuntimeStartInput['model'],
): { provider: string; id: string } | undefined {
  return model ? { provider: model.provider, id: model.model } : undefined;
}

function normalizedTranscript(
  native: NonNullable<LeaseLike['snapshot']>,
): unknown[] {
  return native.transcript.map(normalizeTranscriptEntry);
}

function transcriptFingerprint(
  native: NonNullable<LeaseLike['snapshot']>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizedTranscript(native)), 'utf8')
    .digest('hex');
}

function normalizeTranscriptEntry(entry: unknown): unknown {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    (entry as { role?: unknown }).role !== 'tool'
  )
    return entry;
  const tool = entry as Record<string, unknown>;
  return {
    type: 'tool',
    ...(typeof tool.id === 'string' ? { id: tool.id } : {}),
    ...(typeof tool.toolCallId === 'string'
      ? { toolCallId: tool.toolCallId }
      : {}),
    ...(typeof tool.toolName === 'string' ? { name: tool.toolName } : {}),
    ...(tool.input === undefined ? {} : { arguments: tool.input }),
    ...(tool.content === undefined ? {} : { result: tool.content }),
    ...(typeof tool.status === 'string' ? { status: tool.status } : {}),
    ...(typeof tool.isError === 'boolean' ? { isError: tool.isError } : {}),
    ...(typeof tool.timestamp === 'number'
      ? { timestamp: tool.timestamp }
      : {}),
  };
}

function sessionSnapshot(
  native: NonNullable<LeaseLike['snapshot']>,
): SessionSnapshot {
  const normalized = normalizedTranscript(native);
  const entries = normalized.slice(-MAX_TRANSCRIPT_ITEMS);
  const complete = entries.length === normalized.length;
  while (
    entries.length > 0 &&
    Buffer.byteLength(JSON.stringify(entries)) > MAX_TRANSCRIPT_BYTES
  )
    entries.shift();
  // Keep metadata supplied by newer native clients without making the managed
  // adapter depend on fields older PiClient snapshots do not expose.
  const metadata = native as unknown as {
    file?: string;
    title?: string;
    leafId?: string;
  };
  return {
    id: native.id,
    ...(metadata.file === undefined ? {} : { file: metadata.file }),
    ...(native.name ? { name: native.name } : {}),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    cwd: native.cwd,
    ...(metadata.leafId === undefined ? {} : { leafId: metadata.leafId }),
    entries,
    entriesComplete: complete && entries.length === normalized.length,
  };
}

function runtimeSnapshot(
  input: RuntimeStartInput,
  native: NonNullable<LeaseLike['snapshot']>,
  session = sessionSnapshot(native),
): RuntimeSnapshot {
  return {
    runtimeId: input.runtimeId,
    ownership: 'managed',
    // The upstream server does not expose a process id. The manager never
    // signals this value because this binding has no tmux placement.
    pid: process.pid,
    cwd: native.cwd || input.cwd,
    liveState: native.phase === 'idle' ? 'idle' : 'working',
    session,
    model: {
      provider: native.model.provider,
      model: native.model.id,
      thinking: native.thinkingLevel,
    },
    pendingInteractions: [],
    online: true,
    lastSeenAt: Date.now(),
  };
}

function commandId(command: BridgeCommand): string {
  return command.id;
}

/** A PiClient-backed managed provider for one externally supervised Pi server. */
export class PiClientRuntimeProvider implements AgentRuntimeProvider {
  private readonly contexts = new Map<string, NativeContext>();
  private readonly makeClient: (socketPath: string) => Promise<ClientLike>;

  constructor(
    private readonly registry: RuntimeRegistry | undefined,
    options: {
      clientFactory?: (socketPath: string) => Promise<ClientLike>;
    } = {},
  ) {
    this.makeClient =
      options.clientFactory ??
      ((socketPath) =>
        PiClient.connect({
          transportFactory: createUnixTransportFactory({ path: socketPath }),
        }));
  }

  async start(input: RuntimeStartInput): Promise<RuntimeBinding> {
    if (input.mode === 'read')
      throw nativeFailure(
        new Error('Pi server experiment cannot enforce read-only tool mode.'),
        false,
      );
    let client: ClientLike | undefined;
    let lease: LeaseLike | undefined;
    let context: NativeContext | undefined;
    try {
      client = await this.makeClient(input.socketPath);
      lease = input.sessionId
        ? await client.acquireSession(input.sessionId, { mode: 'exclusive' })
        : await client.createSession({
            cwd: input.cwd,
            ...(input.name ? { name: input.name } : {}),
            ...(modelRef(input.model) ? { model: modelRef(input.model) } : {}),
            ...(input.model?.thinking
              ? {
                  thinkingLevel: input.model.thinking as Parameters<
                    LeaseLike['setThinking']
                  >[0],
                }
              : {}),
          });
      const initial = lease.snapshot;
      if (!initial)
        throw nativeFailure(
          new Error('Pi session has no authoritative snapshot.'),
          true,
        );
      const socket = new VirtualBridgeSocket(async (line) => {
        await this.handleLine(context, line);
      });
      context = new NativeContext(input, client, lease, socket, () => {
        if (this.contexts.get(input.runtimeId) === context)
          this.contexts.delete(input.runtimeId);
      });
      this.contexts.set(input.runtimeId, context);
      context.start();
      if (this.registry) {
        this.registry.accept(socket as unknown as Socket);
        context.sendHello(initial);
        const deadline = Date.now() + 1_000;
        while (!this.registry.get(input.runtimeId) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 5));
        if (!this.registry.get(input.runtimeId))
          throw nativeFailure(
            new Error('Pi virtual bridge handshake was not accepted.'),
            true,
          );
      }
      return {
        runtimeId: input.runtimeId,
        location: {
          id: `pi-server:${initial.id}`,
          sessionId: initial.id,
          displayTarget: `pi-server://${initial.id}`,
        },
      };
    } catch (error) {
      const established = Boolean(lease || context);
      if (context) {
        await context.dispose();
        this.contexts.delete(input.runtimeId);
      } else {
        await lease?.dispose().catch(() => undefined);
        await client?.dispose().catch(() => undefined);
      }
      throw nativeFailure(error, established);
    }
  }

  async attach(input: {
    runtimeId: string;
    location: RuntimeLocation;
  }): Promise<RuntimeBinding> {
    const context = this.contexts.get(input.runtimeId);
    if (context && input.location.sessionId === context.sessionId)
      return {
        runtimeId: input.runtimeId,
        location: input.location,
      };
    throw new Error(
      'Pi server runtime recovery is unsupported: PiClient has no automatic reconnect and the daemon will not relaunch a session.',
    );
  }

  async stop(binding: RuntimeBinding): Promise<void> {
    const context = this.contexts.get(binding.runtimeId);
    if (!context) return;
    await context.dispose();
    this.contexts.delete(binding.runtimeId);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.contexts.values()].map((context) => context.dispose()),
    );
    this.contexts.clear();
  }

  async send(binding: RuntimeBinding, command: RuntimeCommand): Promise<void> {
    const context = this.contexts.get(binding.runtimeId);
    if (!context) throw new Error('Pi server runtime is unavailable.');
    await context.execute(command as BridgeCommand);
  }

  subscribe(
    binding: RuntimeBinding,
    listener: (event: RuntimeProviderEvent) => void,
  ): () => void {
    const context = this.contexts.get(binding.runtimeId);
    if (!context) return () => undefined;
    context.listeners.add(listener);
    return () => context.listeners.delete(listener);
  }

  private async handleLine(
    context: NativeContext | undefined,
    line: string,
  ): Promise<void> {
    if (!context) throw new Error('Pi virtual bridge is not initialized.');
    const frame = parseFrame(line);
    if (frame.kind !== 'command')
      throw new Error('Pi virtual bridge received an event.');
    const command = frame.command;
    try {
      const result = await context.execute(command);
      context.socket.send({
        kind: 'ack',
        id: commandId(command),
        ok: true,
        result,
      });
      context.afterAcknowledged(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.socket.send({
        kind: 'ack',
        id: commandId(command),
        ok: false,
        error: message,
      });
    }
  }
}

class NativeContext {
  readonly listeners = new Set<(event: RuntimeProviderEvent) => void>();
  private sequence = 0;
  private previousPhase: NonNullable<LeaseLike['snapshot']>['phase'];
  private heartbeat: NodeJS.Timeout | undefined;
  private unsubscribeSnapshot: (() => void) | undefined;
  private unsubscribeConnection: (() => void) | undefined;
  private disposed = false;
  private previousTranscriptFingerprint: string;

  constructor(
    private readonly input: RuntimeStartInput,
    private readonly client: ClientLike,
    private readonly lease: LeaseLike,
    readonly socket: VirtualBridgeSocket,
    private readonly onDisposed: () => void,
  ) {
    const snapshot = lease.snapshot;
    if (!snapshot) throw new Error('Pi session snapshot disappeared.');
    this.previousPhase = snapshot.phase;
    this.previousTranscriptFingerprint = transcriptFingerprint(snapshot);
  }

  start(): void {
    this.unsubscribeSnapshot = this.lease.subscribe((snapshot) =>
      this.publish(snapshot),
    );
    this.unsubscribeConnection = this.client.onConnectionStateChange(
      (change) => {
        if (change.state === 'disconnected' && !this.disposed)
          void this.dispose();
      },
    );
    this.heartbeat = setInterval(() => {
      const snapshot = this.lease.snapshot;
      if (snapshot && !this.disposed)
        this.sendEvent({
          type: 'runtime.heartbeat',
          state: this.liveState(snapshot),
        });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  sendHello(native: NonNullable<LeaseLike['snapshot']>): void {
    this.sendEvent({
      type: 'runtime.hello',
      protocolVersion: 1,
      token: this.input.launchToken,
      identityToken: this.input.identityToken,
      snapshot: runtimeSnapshot(this.input, native),
    });
  }

  get sessionId(): string {
    return this.lease.id;
  }

  async execute(command: BridgeCommand): Promise<unknown> {
    if (this.disposed) throw new Error('Pi virtual bridge is closed.');
    switch (command.type) {
      case 'prompt':
        return this.accepted(await this.lease.prompt(command.text));
      case 'steer':
        return this.accepted(await this.lease.steer(command.text));
      case 'abort':
        return this.accepted(await this.lease.abort());
      case 'setModel':
        return this.accepted(
          await this.lease.setModel({
            provider: command.provider,
            id: command.model,
          }),
        );
      case 'setThinking':
        return this.accepted(
          await this.lease.setThinking(
            command.level as Parameters<LeaseLike['setThinking']>[0],
          ),
        );
      case 'shutdown':
        return { accepted: true };
      default:
        throw new Error(
          `Pi server experiment does not support ${command.type}.`,
        );
    }
  }

  afterAcknowledged(command: BridgeCommand): void {
    if (command.type !== 'shutdown') return;
    queueMicrotask(() => {
      this.sendEvent({ type: 'runtime.goodbye', reason: 'shutdown' });
    });
  }

  private accepted(snapshot: NonNullable<LeaseLike['snapshot']>): {
    accepted: true;
  } {
    this.publish(snapshot);
    return { accepted: true };
  }

  private publish(native: NonNullable<LeaseLike['snapshot']>): void {
    if (this.disposed) return;
    const next = this.liveState(native);
    const fingerprint = transcriptFingerprint(native);
    const transcriptChanged =
      fingerprint !== this.previousTranscriptFingerprint;
    const session = sessionSnapshot(native);
    const snapshot = runtimeSnapshot(this.input, native, session);
    this.sendEvent({
      type: 'runtime.stateChanged',
      state: next,
      snapshot,
    });
    if (transcriptChanged)
      this.sendEvent({
        type: 'session.snapshot',
        session,
      });
    if (this.previousPhase !== 'idle' && native.phase === 'idle')
      this.sendEvent({ type: 'agent.settled', sessionId: native.id });
    this.previousPhase = native.phase;
    this.previousTranscriptFingerprint = fingerprint;
  }

  private liveState(
    native: NonNullable<LeaseLike['snapshot']>,
  ): 'idle' | 'working' {
    return native.phase === 'idle' ? 'idle' : 'working';
  }

  private sendEvent(event: BridgeEvent): void {
    if (this.disposed) return;
    this.socket.send({ kind: 'event', event, seq: ++this.sequence });
    this.listeners.forEach((listener) => {
      listener({ type: event.type, runtimeId: this.input.runtimeId, event });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribeSnapshot?.();
    this.unsubscribeConnection?.();
    this.socket.destroy();
    await this.lease.dispose().catch(() => undefined);
    await this.client.dispose().catch(() => undefined);
    this.listeners.clear();
    this.onDisposed();
  }
}

/** Selects Pi only for explicitly routed durable runs; all other paths stay tmux. */
export class RuntimeProviderRouter implements AgentRuntimeProvider {
  private readonly owners = new Map<string, AgentRuntimeProvider>();

  constructor(
    private readonly tmux: TmuxRuntimeProvider,
    private readonly pi: PiClientRuntimeProvider | undefined,
    private readonly piSocketPath?: string,
  ) {}

  async start(input: RuntimeStartInput): Promise<RuntimeBinding> {
    if (
      input.mode === 'read' ||
      input.runtimeProvider !== 'pi-server' ||
      !this.pi
    ) {
      const binding = await this.tmux.start(input);
      this.owners.set(input.runtimeId, this.tmux);
      return binding;
    }
    try {
      const binding = await this.pi.start({
        ...input,
        socketPath: this.piSocketPath ?? input.socketPath,
      });
      this.owners.set(input.runtimeId, this.pi);
      return binding;
    } catch (error) {
      if (
        error instanceof PiSessionOwnershipError ||
        (error as NativeFailure).ownershipEstablished
      )
        throw error;
      // Connect/create/attach failed before a lease was owned. No Pi session
      // remains, so the ordinary tmux provider is a safe bounded fallback.
      const binding = await this.tmux.start(input);
      this.owners.set(input.runtimeId, this.tmux);
      return binding;
    }
  }

  async attach(input: {
    runtimeId: string;
    location: RuntimeLocation;
  }): Promise<RuntimeBinding> {
    const owner = this.owners.get(input.runtimeId);
    if (owner) return owner.attach(input);
    const location = input.location;
    if (
      typeof location.sessionId === 'string' &&
      typeof location.windowId === 'string' &&
      typeof location.paneId === 'string'
    ) {
      const binding = await this.tmux.attach(input);
      this.owners.set(input.runtimeId, this.tmux);
      return binding;
    }
    throw new Error(
      'Pi server runtime recovery is unsupported after daemon restart.',
    );
  }

  async stop(binding: RuntimeBinding): Promise<void> {
    const owner = this.owners.get(binding.runtimeId) ?? this.tmux;
    try {
      await owner.stop(binding);
    } finally {
      this.owners.delete(binding.runtimeId);
    }
  }

  async send(binding: RuntimeBinding, command: RuntimeCommand): Promise<void> {
    const owner = this.owners.get(binding.runtimeId) ?? this.tmux;
    return owner.send(binding, command);
  }

  subscribe(
    binding: RuntimeBinding,
    listener: (event: RuntimeProviderEvent) => void,
  ): () => void {
    return (this.owners.get(binding.runtimeId) ?? this.tmux).subscribe(
      binding,
      listener,
    );
  }

  async close(): Promise<void> {
    await this.pi?.close();
    this.owners.clear();
  }
}

/** Compatibility name for callers that describe the provider by transport. */
export { PiClientRuntimeProvider as PiServerRuntimeProvider };
