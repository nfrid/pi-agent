import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  applyRuntimeEvent,
  createRuntimeReducerState,
  type RuntimeReducerState,
} from '@pi-dashboard/domain';
import {
  ContributionError,
  isActionAvailable,
  NonIdempotentActionIdGuard,
  parseActionInput,
  parseRuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import {
  type BridgeCommand,
  type BridgeEvent,
  parseFrame,
  type RuntimeSnapshot,
  redactBridgeEvent,
  serializeFrame,
  validateBridgeCommand,
} from '@pi-dashboard/protocol';

const MAX_BUFFER = 1024 * 1024;
const ACK_TIMEOUT_MS = 15_000;
const PRE_HELLO_TIMEOUT_MS = 5_000;
export const RUNTIME_COMMAND_QUEUE_LIMIT = 64;
export const RUNTIME_HEARTBEAT_TIMEOUT_MS = 30_000;

type QueuedCommand = {
  command: BridgeCommand;
  connection: Socket;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type RuntimeRecord = {
  snapshot: RuntimeSnapshot;
  socket?: Socket;
  buffer: string;
  runtimeEpoch: string;
  reducerState: RuntimeReducerState;
  pending: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  commandQueue: QueuedCommand[];
  commandRunning: boolean;
  writeBlocked: boolean;
  /** Semantic action IDs already handed to Pi in this runtime epoch. */
  actionCommandIds: NonIdempotentActionIdGuard;
};

export type RegistryChange =
  | { kind: 'registered'; snapshot: RuntimeSnapshot }
  | {
      kind: 'event';
      runtimeId: string;
      event: BridgeEvent;
      snapshot: RuntimeSnapshot;
      runtimeEpoch?: string;
      runtimeSeq?: number;
    }
  | { kind: 'offline'; snapshot: RuntimeSnapshot };

export interface RuntimeRegistryOptions {
  expectedToken?: (
    runtimeId: string,
    launchToken: string | undefined,
    identityToken: string | undefined,
  ) => boolean;
  allowExternalWithoutToken?: boolean;
  commandTimeoutMs?: number;
  onChange?: (change: RegistryChange) => void;
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly forgotten = new Set<string>();

  constructor(private readonly options: RuntimeRegistryOptions = {}) {}

  snapshots(): RuntimeSnapshot[] {
    return [...this.runtimes.values()].map(({ snapshot }) => ({ ...snapshot }));
  }

  get(runtimeId: string): RuntimeSnapshot | undefined {
    return this.runtimes.get(runtimeId)?.snapshot;
  }

  isOnline(runtimeId: string): boolean {
    return Boolean(this.runtimes.get(runtimeId)?.socket);
  }

  /** Attach one Unix-socket connection. The first frame must be runtime.hello. */
  accept(socket: Socket): void {
    let record: RuntimeRecord | undefined;
    let helloSeen = false;
    let buffer = '';
    const reject = () => socket.destroy();
    const helloTimer = setTimeout(() => {
      if (!helloSeen) reject();
    }, PRE_HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    socket.setEncoding('utf8');
    socket.once('timeout', () => socket.destroy());
    const onData = (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BUFFER) return reject();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          newline = buffer.indexOf('\n');
          continue;
        }
        let frame: ReturnType<typeof parseFrame>;
        try {
          frame = parseFrame(line);
        } catch (error) {
          // Capability uniqueness is semantic validation layered over the
          // structural frame schema. An invalid update is ignored as a whole;
          // it must not tear down an otherwise healthy runtime connection.
          if (
            error instanceof ContributionError &&
            (error.code === 'invalid-capability-snapshot' ||
              error.code === 'duplicate-action-id')
          ) {
            newline = buffer.indexOf('\n');
            continue;
          }
          return reject();
        }
        if (!helloSeen) {
          if (frame.kind !== 'event' || frame.event.type !== 'runtime.hello')
            return reject();
          const hello = redactBridgeEvent(frame.event) as Extract<
            BridgeEvent,
            { type: 'runtime.hello' }
          >;
          const snapshot = hello.snapshot;
          if (
            hello.protocolVersion !== 1 ||
            !snapshot.runtimeId ||
            !snapshot.cwd ||
            !snapshot.session?.id
          )
            return reject();
          const tokenOk =
            this.options.expectedToken?.(
              snapshot.runtimeId,
              hello.token,
              hello.identityToken,
            ) ?? false;
          if (
            !tokenOk &&
            !(
              this.options.allowExternalWithoutToken &&
              snapshot.ownership === 'external' &&
              !hello.token
            )
          )
            return reject();
          if (this.forgotten.has(snapshot.runtimeId)) return reject();
          const old = this.runtimes.get(snapshot.runtimeId);
          if (old?.socket && old.socket !== socket) old.socket.destroy();
          // A v1 bridge may put the capability snapshot only on hello. Install
          // it into the authoritative runtime snapshot when it validates; an
          // absent/unknown capability payload remains absent and is safe.
          const helloCapabilities =
            hello.capabilities?.extensions ??
            hello.capabilities?.extensionCapabilities ??
            (hello.capabilities?.capabilitySummaries !== undefined ||
            hello.capabilities?.manifests !== undefined
              ? {
                  version: 1 as const,
                  capabilities: hello.capabilities.capabilitySummaries ?? [],
                  manifests: hello.capabilities.manifests ?? [],
                }
              : undefined);
          const advertised = helloCapabilities
            ? (() => {
                try {
                  return parseRuntimeCapabilitySnapshot(helloCapabilities);
                } catch {
                  return undefined;
                }
              })()
            : undefined;
          const snapshotCapabilities = snapshot.capabilities
            ? (() => {
                try {
                  return parseRuntimeCapabilitySnapshot(snapshot.capabilities);
                } catch {
                  return undefined;
                }
              })()
            : undefined;
          const advertisedSnapshot = snapshotCapabilities ?? advertised;
          clearTimeout(helloTimer);
          try {
            // Only heartbeat-capable clients get an idle deadline. Agents
            // already running during this rollout use protocol v1 without the
            // capability and must remain connected until their next reload.
            socket.setTimeout(
              hello.capabilities?.heartbeat ? RUNTIME_HEARTBEAT_TIMEOUT_MS : 0,
            );
          } catch {
            /* best effort */
          }
          const runtimeEpoch = randomUUID();
          const snapshotForRegistration =
            snapshotCapabilities === undefined &&
            snapshot.capabilities !== undefined
              ? (({ capabilities: _invalid, ...withoutCapabilities }) =>
                  withoutCapabilities)(snapshot)
              : snapshot;
          const registeredSnapshot = {
            ...snapshotForRegistration,
            ...(advertisedSnapshot === undefined
              ? {}
              : { capabilities: advertisedSnapshot }),
            online: true,
            lastSeenAt: Date.now(),
          };
          record = {
            snapshot: registeredSnapshot,
            socket,
            buffer: '',
            runtimeEpoch,
            reducerState: createRuntimeReducerState(registeredSnapshot, {
              runtimeEpoch,
              runtimeSeq: frame.seq,
            }),
            pending: new Map(),
            commandQueue: [],
            commandRunning: false,
            writeBlocked: false,
            actionCommandIds: new NonIdempotentActionIdGuard(),
          };
          this.runtimes.set(snapshot.runtimeId, record);
          helloSeen = true;
          this.options.onChange?.({
            kind: 'registered',
            snapshot: record.snapshot,
          });
        } else if (record) {
          this.handleFrame(record, frame);
        }
        newline = buffer.indexOf('\n');
      }
    };
    socket.on('data', onData);
    socket.once('close', () => {
      clearTimeout(helloTimer);
      socket.off('data', onData);
      if (!record) return;
      if (record.socket === socket) record.socket = undefined;
      const disconnected = new Error('Runtime bridge disconnected.');
      for (const pending of record.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(disconnected);
      }
      record.pending.clear();
      for (const queued of record.commandQueue) queued.reject(disconnected);
      record.commandQueue = [];
      record.writeBlocked = false;
      if (this.runtimes.get(record.snapshot.runtimeId) === record) {
        record.snapshot = {
          ...record.snapshot,
          online: false,
          lastSeenAt: Date.now(),
        };
        this.options.onChange?.({ kind: 'offline', snapshot: record.snapshot });
      }
    });
    socket.once('error', () => socket.destroy());
  }

  /** Remove a stopped or unusable runtime and reject reconnects for this daemon lifetime. */
  forget(runtimeId: string, tombstone = true): RuntimeSnapshot | undefined {
    const record = this.runtimes.get(runtimeId);
    if (tombstone) this.forgotten.add(runtimeId);
    if (!record) return undefined;
    this.runtimes.delete(runtimeId);
    const removed = new Error('Runtime was removed.');
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(removed);
    }
    record.pending.clear();
    for (const queued of record.commandQueue) queued.reject(removed);
    record.commandQueue = [];
    record.writeBlocked = false;
    record.socket?.destroy();
    return record.snapshot;
  }

  sendCommand(runtimeId: string, input: unknown): Promise<unknown> {
    const record = this.runtimes.get(runtimeId);
    const connection = record?.socket;
    if (!record || !connection || connection.destroyed)
      return Promise.reject(new Error('Runtime is offline.'));
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return Promise.reject(new Error('Invalid command.'));
    let command: BridgeCommand;
    try {
      const candidate = input as Record<string, unknown>;
      command = validateBridgeCommand({
        ...candidate,
        // Existing HTTP callers omit IDs; semantic callers retain their
        // caller-owned stable ID so retries cannot become a second action.
        id:
          typeof candidate.id === 'string' && candidate.id.length > 0
            ? candidate.id
            : randomUUID(),
      });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    if (
      record.commandQueue.length + (record.commandRunning ? 1 : 0) >=
      RUNTIME_COMMAND_QUEUE_LIMIT
    )
      return Promise.reject(new Error('Runtime command queue is full.'));
    if (command.type === 'action.invoke') {
      // Keep direct lookup behind the same semantic validation as the bridge
      // parser. This is defense in depth for typed callers and old records.
      let capabilities: RuntimeSnapshot['capabilities'];
      try {
        capabilities = record.snapshot.capabilities
          ? parseRuntimeCapabilitySnapshot(record.snapshot.capabilities)
          : undefined;
      } catch {
        return Promise.reject(
          Object.assign(
            new Error(`Runtime does not advertise action ${command.actionId}.`),
            { code: 'unknown-action' },
          ),
        );
      }
      const action = capabilities?.manifests
        .flatMap((manifest) => manifest.actions)
        .find((item) => item.id === command.actionId);
      if (!capabilities || !action)
        return Promise.reject(
          Object.assign(
            new Error(`Runtime does not advertise action ${command.actionId}.`),
            { code: 'unknown-action' },
          ),
        );
      if (
        !isActionAvailable(action, capabilities, {
          online: true,
          liveState: record.snapshot.liveState,
          pendingInteractions: record.snapshot.pendingInteractions.length,
        })
      )
        return Promise.reject(
          Object.assign(
            new Error(`Runtime action ${command.actionId} is unavailable.`),
            { code: 'unavailable-action' },
          ),
        );
      try {
        parseActionInput(action, command.input);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      if (!action.idempotent) {
        const reservation = record.actionCommandIds.reserve(command.id);
        if (reservation === 'duplicate')
          return Promise.reject(
            Object.assign(new Error('Duplicate semantic action command ID.'), {
              code: 'duplicate-action-id',
            }),
          );
        if (reservation === 'capacity')
          return Promise.reject(
            Object.assign(
              new Error('Non-idempotent action command capacity is full.'),
              { code: 'action-command-capacity' },
            ),
          );
      }
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      // The reservation above occurs only after queue admission; a rejected
      // queue admission is not a consumed action ID.
      record.commandQueue.push({
        command,
        connection,
        resolve,
        reject,
      });
    });
    this.pumpCommands(runtimeId, record);
    return promise;
  }

  close(): void {
    const closed = new Error('Runtime registry closed.');
    for (const record of this.runtimes.values()) {
      for (const pending of record.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(closed);
      }
      record.pending.clear();
      for (const queued of record.commandQueue) queued.reject(closed);
      record.commandQueue = [];
      record.writeBlocked = false;
      record.socket?.destroy();
    }
    this.runtimes.clear();
    this.forgotten.clear();
  }

  private pumpCommands(runtimeId: string, record: RuntimeRecord): void {
    if (record.commandRunning || record.writeBlocked) return;
    const queued = record.commandQueue.shift();
    if (!queued) return;
    record.commandRunning = true;
    void this.executeCommand(runtimeId, record, queued).finally(() => {
      record.commandRunning = false;
      this.pumpCommands(runtimeId, record);
    });
  }

  private async executeCommand(
    runtimeId: string,
    record: RuntimeRecord,
    queued: QueuedCommand,
  ): Promise<void> {
    const { connection, command } = queued;
    const current = this.runtimes.get(runtimeId);
    // A queued command belongs to the connection that was current when the
    // browser requested it. Never move it to a replacement socket.
    if (
      current !== record ||
      record.socket !== connection ||
      connection.destroyed
    ) {
      queued.reject(new Error('Runtime bridge connection was replaced.'));
      return;
    }
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          current.pending.delete(command.id);
          // If the kernel never drained, keeping this connection would leave
          // the queue permanently blocked while heartbeats still mark it live.
          // Reconnect to restore a known writable generation.
          if (record.writeBlocked && record.socket === connection)
            connection.destroy();
          reject(new Error('Runtime command acknowledgement timed out.'));
        }, this.options.commandTimeoutMs ?? ACK_TIMEOUT_MS);
        current.pending.set(command.id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          timer,
        });
        try {
          const accepted = connection.write(
            serializeFrame({ kind: 'command', command }),
          );
          if (!accepted) {
            record.writeBlocked = true;
            connection.once('drain', () => {
              if (record.socket !== connection) return;
              record.writeBlocked = false;
              this.pumpCommands(runtimeId, record);
            });
          }
        } catch (error) {
          current.pending.delete(command.id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      queued.resolve(result);
    } catch (error) {
      queued.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleFrame(
    record: RuntimeRecord,
    frame: ReturnType<typeof parseFrame>,
  ): void {
    if (this.runtimes.get(record.snapshot.runtimeId) !== record) return;
    if (frame.kind === 'ack') {
      const pending = record.pending.get(frame.id);
      if (!pending) return;
      record.pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.result);
      else {
        const error = new Error(frame.error);
        if (frame.code) Object.assign(error, { code: frame.code });
        pending.reject(error);
      }
      return;
    }
    if (frame.kind !== 'event') return;
    const event = redactBridgeEvent(frame.event);
    const reduced = applyRuntimeEvent(record.reducerState, {
      event,
      runtimeEpoch: record.runtimeEpoch,
      runtimeSeq: frame.seq,
    });
    if (!reduced.accepted) return;
    record.reducerState = reduced.state;
    record.snapshot = {
      ...reduced.state.snapshot,
      online: true,
      lastSeenAt: Date.now(),
    };
    // lastSeenAt and online are transport-owned observations, but keeping them
    // in reducer state makes the next event a pure continuation of this one.
    record.reducerState = { ...record.reducerState, snapshot: record.snapshot };
    if (event.type === 'runtime.goodbye') {
      record.socket?.end();
      // Remove first so observers build their authoritative snapshot after the
      // cleanly exited runtime has left the registry.
      this.forget(record.snapshot.runtimeId, event.reason !== 'reload');
    }
    this.options.onChange?.({
      kind: 'event',
      runtimeId: record.snapshot.runtimeId,
      event,
      snapshot: record.snapshot,
      runtimeEpoch: record.runtimeEpoch,
      runtimeSeq: frame.seq,
    });
  }
}
