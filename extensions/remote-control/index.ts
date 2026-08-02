import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type BridgeCommand,
  type BridgeEvent,
  type InteractionSnapshot,
  PROTOCOL_VERSION,
  parseFrame,
  type RuntimeLiveState,
  type RuntimeSnapshot,
  type SessionSnapshot,
  serializeFrame,
} from '../../packages/dashboard-protocol/src/index';
import {
  getInteractionBroker,
  type InteractionBroker,
} from '../ask-user/broker';
import { defineExtension } from '../shared/runtime/extension';

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const MAX_LINE_BYTES = 512 * 1024;

type CommandHandler = (command: BridgeCommand) => Promise<unknown>;

export interface BridgeClientOptions {
  socketPath: string;
  token?: string;
  runtimeId: string;
  snapshot: () => RuntimeSnapshot;
  handleCommand: CommandHandler;
  broker?: InteractionBroker;
}

/** Reconnecting JSONL client. It never queues browser commands while offline. */
export class BridgeClient {
  private socket: net.Socket | undefined;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = RECONNECT_MIN_MS;
  private buffer = '';
  private seq = 0;
  private commandTail = Promise.resolve();
  private unsubscribeBroker: (() => void) | undefined;

  constructor(private readonly options: BridgeClientOptions) {
    this.unsubscribeBroker = options.broker?.subscribe((event) => {
      if (event.kind === 'requested') {
        this.sendEvent({
          type: 'interaction.requested',
          interaction: event.interaction,
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
    this.unsubscribeBroker?.();
    this.unsubscribeBroker = undefined;
    this.socket?.destroy();
    this.socket = undefined;
  }

  sendEvent(event: BridgeEvent): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(serializeFrame({ kind: 'event', event, seq: ++this.seq }));
      return true;
    } catch {
      socket.destroy();
      return false;
    }
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const socket = net.createConnection(this.options.socketPath);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.sendEvent({
        type: 'runtime.hello',
        protocolVersion: PROTOCOL_VERSION,
        token: this.options.token,
        snapshot: this.options.snapshot(),
      });
      // A daemon restart gets a complete interaction set, not only events
      // emitted after this connection was established.
      for (const interaction of this.options.broker?.list() ?? []) {
        this.sendEvent({ type: 'interaction.requested', interaction });
      }
    });
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.scheduleReconnect();
    });
  }

  private onData(chunk: string): void {
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
          if (frame.kind === 'command') this.enqueue(frame.command);
        } catch {
          // Malformed browser/daemon data is ignored; the socket remains
          // usable for the next bounded frame.
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private enqueue(command: BridgeCommand): void {
    this.commandTail = this.commandTail
      .then(async () => {
        try {
          const result = await this.options.handleCommand(command);
          this.sendAck(command.id, true, result);
        } catch (error) {
          this.sendAck(
            command.id,
            false,
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .catch(() => undefined);
  }

  private sendAck(id: string, ok: true, result?: unknown): void;
  private sendAck(id: string, ok: false, result: string): void;
  private sendAck(id: string, ok: boolean, result?: unknown): void {
    if (ok) this.sendRaw({ kind: 'ack', id, ok: true, result });
    else
      this.sendRaw({
        kind: 'ack',
        id,
        ok: false,
        error: String(result ?? 'Command failed.'),
      });
  }

  private sendRaw(frame: Parameters<typeof serializeFrame>[0]): void {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;
    try {
      this.socket.write(serializeFrame(frame));
    } catch {
      this.socket.destroy();
    }
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

function jsonSafe(value: unknown, max = 480_000): unknown {
  try {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text) > max) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function sessionSnapshot(ctx: ExtensionContext): SessionSnapshot {
  const manager = ctx.sessionManager;
  const entries = manager.getBranch() as readonly unknown[];
  return {
    id: manager.getSessionId(),
    file: manager.getSessionFile(),
    name: manager.getSessionName(),
    cwd: manager.getCwd(),
    leafId: manager.getLeafId() ?? undefined,
    entries: (jsonSafe(entries) as readonly unknown[] | undefined) ?? [],
  };
}

function modelSnapshot(ctx: ExtensionContext): RuntimeSnapshot['model'] {
  const model = ctx.model;
  if (!model) return undefined;
  return {
    provider: model.provider,
    model: model.id,
    thinking: ctx.thinkingLevel,
  };
}

function liveState(
  ctx: ExtensionContext,
  broker: InteractionBroker,
): RuntimeLiveState {
  if (broker.list().length > 0) return 'waiting';
  return ctx.isIdle() ? 'idle' : 'working';
}

function interactionSnapshot(
  interaction: ReturnType<InteractionBroker['list']>[number],
): InteractionSnapshot {
  return interaction;
}

export interface RemoteControlRuntime {
  readonly runtimeId: string;
  readonly client: BridgeClient;
  setContext(ctx: ExtensionContext): void;
  isCurrent(ctx: ExtensionContext): boolean;
}

export function createRemoteControlRuntime(
  pi: ExtensionAPI,
): RemoteControlRuntime | undefined {
  const socketPath = process.env.PI_DASHBOARD_SOCKET;
  if (!socketPath) return undefined;
  const runtimeId =
    process.env.PI_DASHBOARD_RUNTIME_ID || `runtime-${randomUUID()}`;
  const ownership = process.env.PI_DASHBOARD_RUNTIME_ID
    ? 'managed'
    : 'external';
  const broker = getInteractionBroker();
  let context: ExtensionContext | undefined;
  let lastError: string | undefined;
  const client = new BridgeClient({
    socketPath,
    token: process.env.PI_DASHBOARD_TOKEN,
    runtimeId,
    broker,
    snapshot: () => {
      if (!context) {
        return {
          runtimeId,
          ownership,
          pid: process.pid,
          cwd: process.cwd(),
          liveState: 'idle',
          session: { id: 'unknown', entries: [] },
          pendingInteractions: broker.list().map(interactionSnapshot),
        };
      }
      const usage = context.getContextUsage();
      return {
        runtimeId,
        ownership,
        pid: process.pid,
        cwd: context.cwd,
        liveState: liveState(context, broker),
        session: sessionSnapshot(context),
        model: modelSnapshot(context),
        contextUsage: usage
          ? {
              tokens: usage.tokens,
              contextWindow: usage.contextWindow,
              percent: usage.percent,
            }
          : undefined,
        pendingInteractions: broker.list().map(interactionSnapshot),
        lastError,
      };
    },
    handleCommand: async (command) => {
      if (!context) throw new Error('Pi session is not ready.');
      switch (command.type) {
        case 'prompt':
          if (!context.isIdle())
            throw new Error('Agent is working; choose steer or follow-up.');
          pi.sendUserMessage(command.text);
          return { accepted: true };
        case 'steer':
        case 'followUp':
          pi.sendUserMessage(command.text, {
            deliverAs: command.type === 'steer' ? 'steer' : 'followUp',
          });
          return { accepted: true, mode: command.type };
        case 'abort':
          context.abort();
          return { accepted: true };
        case 'shutdown':
          context.shutdown();
          return { accepted: true };
        case 'setModel': {
          const model = context.modelRegistry.find(
            command.provider,
            command.model,
          );
          if (!model) throw new Error('Requested model is not available.');
          if (!(await pi.setModel(model)))
            throw new Error('Model authentication is unavailable.');
          return { accepted: true };
        }
        case 'setThinking':
          pi.setThinkingLevel(command.level as never);
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
    },
  });

  const setContext = (ctx: ExtensionContext) => {
    context = ctx;
    lastError = undefined;
  };
  const isCurrent = (ctx: ExtensionContext) => context === ctx;
  return { runtimeId, client, setContext, isCurrent };
}

function emitState(runtime: RemoteControlRuntime, ctx: ExtensionContext): void {
  if (!runtime.isCurrent(ctx)) return;
  runtime.client.sendEvent({
    type: 'runtime.stateChanged',
    state: liveState(ctx, getInteractionBroker()),
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
      if (runtime.isCurrent(ctx)) handler(value, ctx);
    });

  pi.on('session_start', (_event, ctx) => {
    runtime.setContext(ctx);
    runtime.client.start();
    runtime.client.sendEvent({
      type: 'session.snapshot',
      session: sessionSnapshot(ctx),
    });
  });
  pi.on('session_info_changed', (_event, ctx) => {
    runtime.setContext(ctx);
    runtime.client.sendEvent({
      type: 'session.changed',
      session: sessionSnapshot(ctx),
    });
  });
  pi.on('agent_start', (_event, ctx) => emitState(runtime, ctx));
  pi.on('agent_settled', (_event, ctx) => {
    emitState(runtime, ctx);
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
      message: jsonSafe(event),
    }),
  );
  onCurrentTransportEvent('message_update', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'message.updated',
      sessionId: ctx.sessionManager.getSessionId(),
      message: jsonSafe(event),
    }),
  );
  onCurrentTransportEvent('message_end', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'message.finished',
      sessionId: ctx.sessionManager.getSessionId(),
      message: jsonSafe(event),
    }),
  );
  onCurrentTransportEvent('tool_execution_start', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'tool.started',
      sessionId: ctx.sessionManager.getSessionId(),
      tool: jsonSafe(event),
    }),
  );
  onCurrentTransportEvent('tool_execution_update', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'tool.updated',
      sessionId: ctx.sessionManager.getSessionId(),
      tool: jsonSafe(event),
    }),
  );
  onCurrentTransportEvent('tool_execution_end', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'tool.finished',
      sessionId: ctx.sessionManager.getSessionId(),
      tool: jsonSafe(event),
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
  pi.on('session_shutdown', (_event, ctx) => {
    if (!runtime.isCurrent(ctx)) return;
    runtime.client.sendEvent({ type: 'runtime.goodbye' });
    runtime.client.stop();
    runtime.setContext(ctx);
  });
});
