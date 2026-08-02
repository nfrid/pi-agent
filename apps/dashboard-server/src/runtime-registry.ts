import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  type BridgeEvent,
  parseFrame,
  type RuntimeSnapshot,
  serializeFrame,
  validateBridgeCommand,
} from '@pi-dashboard/protocol';

const MAX_BUFFER = 1024 * 1024;
const ACK_TIMEOUT_MS = 15_000;

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
  commandTail: Promise<void>;
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
  onChange?: (change: RegistryChange) => void;
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeRecord>();

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
    socket.setEncoding('utf8');
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
          const hello = frame.event;
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
          const old = this.runtimes.get(snapshot.runtimeId);
          if (old?.socket && old.socket !== socket) old.socket.destroy();
          record = {
            snapshot: { ...snapshot, online: true, lastSeenAt: Date.now() },
            socket,
            buffer: '',
            lastSeq: frame.seq,
            pending: new Map(),
            commandTail: Promise.resolve(),
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
      socket.off('data', onData);
      if (
        record &&
        this.runtimes.get(record.snapshot.runtimeId) === record &&
        record.socket === socket
      ) {
        record.socket = undefined;
        record.snapshot = {
          ...record.snapshot,
          online: false,
          lastSeenAt: Date.now(),
        };
        for (const pending of record.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Runtime bridge disconnected.'));
        }
        record.pending.clear();
        this.options.onChange?.({ kind: 'offline', snapshot: record.snapshot });
      }
    });
    socket.once('error', () => socket.destroy());
  }

  sendCommand(runtimeId: string, input: unknown): Promise<unknown> {
    const record = this.runtimes.get(runtimeId);
    if (!record?.socket || record.socket.destroyed)
      return Promise.reject(new Error('Runtime is offline.'));
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return Promise.reject(new Error('Invalid command.'));
    const command = validateBridgeCommand({
      ...(input as Record<string, unknown>),
      id: randomUUID(),
    });
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (error: Error) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    record.commandTail = record.commandTail
      .then(async () => {
        const current = this.runtimes.get(runtimeId);
        const socket = current?.socket;
        if (!current || !socket || socket.destroyed)
          throw new Error('Runtime is offline.');
        const result = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            current.pending.delete(command.id);
            reject(new Error('Runtime command acknowledgement timed out.'));
          }, ACK_TIMEOUT_MS);
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
            socket.write(serializeFrame({ kind: 'command', command }));
          } catch (error) {
            current.pending.delete(command.id);
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        resolveResult(result);
      })
      .then(undefined, rejectResult)
      .catch(() => undefined);
    return promise;
  }

  close(): void {
    for (const record of this.runtimes.values()) record.socket?.destroy();
    this.runtimes.clear();
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
    const event = frame.event;
    record.snapshot = this.mergeEvent(record.snapshot, event);
    record.snapshot = {
      ...record.snapshot,
      online: true,
      lastSeenAt: Date.now(),
    };
    if (event.type === 'runtime.goodbye') record.socket?.end();
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
        return { ...event.snapshot, online: true };
      case 'runtime.heartbeat':
      case 'runtime.stateChanged':
        return {
          ...snapshot,
          liveState: event.state,
          ...(event.snapshot ?? {}),
        };
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
