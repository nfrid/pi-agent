import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

type CommandInfo = ReturnType<ExtensionAPI['getCommands']>[number];

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
): Promise<{ accepted: true; command?: string }> {
  const invocation = commandParts(text);
  if (invocation && !deliverAs) {
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
  pi.sendUserMessage(expanded, deliverAs ? { deliverAs } : undefined);
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
      let snapshot: RuntimeSnapshot;
      try {
        snapshot = this.options.snapshot();
      } catch {
        socket.destroy();
        return;
      }
      this.sendEvent({
        type: 'runtime.hello',
        protocolVersion: PROTOCOL_VERSION,
        token: this.options.token,
        identityToken: this.options.identityToken,
        snapshot,
      });
      // A daemon restart gets a complete interaction set, not only events
      // emitted after this connection was established.
      for (const interaction of this.options.broker?.list() ?? []) {
        this.sendEvent({ type: 'interaction.requested', interaction });
      }
    });
    socket.on('data', (chunk: string) => this.onData(socket, chunk));
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      if (this.socket !== socket) return;
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
    this.commandTail = this.commandTail
      .then(async () => {
        // Commands received on a replaced generation are abandoned rather than
        // replayed. Replaying could duplicate a prompt after a daemon retry.
        if (socket !== this.socket || socket.destroyed) return;
        try {
          const result = await this.options.handleCommand(command);
          this.sendAck(socket, command.id, true, result);
        } catch (error) {
          this.sendAck(
            socket,
            command.id,
            false,
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .catch(() => undefined);
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
  ): void;
  private sendAck(
    socket: net.Socket,
    id: string,
    ok: boolean,
    result?: unknown,
  ): void {
    if (ok) this.sendRaw(socket, { kind: 'ack', id, ok: true, result });
    else
      this.sendRaw(socket, {
        kind: 'ack',
        id,
        ok: false,
        error: String(result ?? 'Command failed.'),
      });
  }

  private sendRaw(
    socket: net.Socket,
    frame: Parameters<typeof serializeFrame>[0],
  ): void {
    if (socket !== this.socket || socket.destroyed || !socket.writable) return;
    try {
      socket.write(serializeFrame(frame));
    } catch {
      socket.destroy();
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
    // Socket callbacks run outside Pi's extension event dispatch. Returning a
    // cache keeps reconnects from dereferencing a context that was invalidated
    // by session replacement or extension reload.
    snapshot: () => cachedSnapshot,
    handleCommand: async (command) => {
      if (!context) throw new Error('Pi session is not ready.');
      switch (command.type) {
        case 'prompt':
          if (!context.isIdle())
            throw new Error('Agent is working; choose steer or follow-up.');
          return dispatchDashboardInput(pi, context, command.text);
        case 'steer':
        case 'followUp':
          return {
            ...(await dispatchDashboardInput(
              pi,
              context,
              command.text,
              command.type === 'steer' ? 'steer' : 'followUp',
            )),
            mode: command.type,
          };
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
    try {
      lastError = undefined;
      const next = snapshotFrom(ctx);
      const nextScope = ctx.sessionManager.getSessionId();
      if (contextScope && contextScope !== nextScope)
        broker.cancelScope(contextScope);
      context = ctx;
      contextScope = nextScope;
      currentSessionId = next.session.id;
      cachedSnapshot = next;
    } catch (error) {
      if (contextScope) broker.cancelScope(contextScope);
      context = undefined;
      contextScope = undefined;
      currentSessionId = undefined;
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
    cachedSnapshot = unavailableSnapshot();
  };
  return {
    runtimeId,
    client,
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
