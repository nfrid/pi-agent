import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
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
  lastSeq: number;
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
};

export type RegistryChange =
  | { kind: 'registered'; snapshot: RuntimeSnapshot }
  | {
      kind: 'event';
      runtimeId: string;
      event: BridgeEvent;
      snapshot: RuntimeSnapshot;
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
        } catch {
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
          record = {
            snapshot: { ...snapshot, online: true, lastSeenAt: Date.now() },
            socket,
            buffer: '',
            lastSeq: frame.seq,
            pending: new Map(),
            commandQueue: [],
            commandRunning: false,
            writeBlocked: false,
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
      command = validateBridgeCommand({
        ...(input as Record<string, unknown>),
        id: randomUUID(),
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
    const promise = new Promise<unknown>((resolve, reject) => {
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
      else pending.reject(new Error(frame.error));
      return;
    }
    if (frame.kind !== 'event' || frame.seq <= record.lastSeq) return;
    record.lastSeq = frame.seq;
    const event = redactBridgeEvent(frame.event);
    record.snapshot = this.mergeEvent(record.snapshot, event);
    record.snapshot = {
      ...record.snapshot,
      online: true,
      lastSeenAt: Date.now(),
    };
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
    });
  }

  private mergeEvent(
    snapshot: RuntimeSnapshot,
    event: BridgeEvent,
  ): RuntimeSnapshot {
    switch (event.type) {
      case 'runtime.hello':
        // Hello is only accepted during registration. A later hello must not
        // be able to replace the established runtime identity.
        return snapshot;
      case 'runtime.heartbeat':
      case 'runtime.stateChanged': {
        const update = event.snapshot;
        return {
          ...snapshot,
          ...(update?.cwd === undefined ? {} : { cwd: update.cwd }),
          ...(update?.workspaceHint === undefined
            ? {}
            : { workspaceHint: update.workspaceHint }),
          ...(update?.tmux === undefined ? {} : { tmux: update.tmux }),
          liveState: event.state,
          ...(update?.session === undefined ? {} : { session: update.session }),
          ...(update?.model === undefined ? {} : { model: update.model }),
          ...(update?.contextUsage === undefined
            ? {}
            : { contextUsage: update.contextUsage }),
          ...(update?.pendingInteractions === undefined
            ? {}
            : { pendingInteractions: update.pendingInteractions }),
          ...(update?.lastError === undefined
            ? {}
            : { lastError: update.lastError }),
          ...(update?.online === undefined ? {} : { online: update.online }),
          ...(update?.lastSeenAt === undefined
            ? {}
            : { lastSeenAt: update.lastSeenAt }),
        };
      }
      case 'session.changed':
      case 'session.snapshot':
        return { ...snapshot, session: event.session };
      case 'interaction.requested':
        return {
          ...snapshot,
          pendingInteractions: [
            ...snapshot.pendingInteractions.filter(
              (item) => item.id !== event.interaction.id,
            ),
            event.interaction,
          ],
          liveState: 'waiting',
        };
      case 'interaction.resolved':
        return {
          ...snapshot,
          pendingInteractions: snapshot.pendingInteractions.filter(
            (item) => item.id !== event.interactionId,
          ),
        };
      case 'agent.settled':
        return {
          ...snapshot,
          liveState:
            snapshot.pendingInteractions.length > 0 ? 'waiting' : 'idle',
        };
      case 'runtime.goodbye':
        return { ...snapshot, online: false };
      default:
        return snapshot;
    }
  }
}
