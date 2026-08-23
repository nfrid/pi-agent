import { createHash } from 'node:crypto';
import {
  type BridgeCommand,
  type CommandReceipt,
  parseRenameSessionMutationInput,
  parseRestartRuntimeMutationInput,
  parseStartRuntimeMutationInput,
  parseStopRuntimeMutationInput,
  type RenameSessionMutationOutput,
  type RestartRuntimeMutationOutput,
  type RuntimeCommandOutput,
  type RuntimeSnapshot,
  type StartRuntimeMutationOutput,
  type StopRuntimeMutationOutput,
  validateBridgeCommand,
} from '@pi-dashboard/protocol';
import type { OrchestrationRepository } from '../repositories/types.js';
import type { RuntimeManager } from '../runtime-manager.js';
import type { RuntimeRegistry } from '../runtime-registry.js';
import type { SessionIndex } from '../session-index.js';

/** Runtime commands exposed to browser adapters without transport types. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

function runtimeCommandFingerprint(
  runtimeId: string,
  payload: unknown,
): string {
  return createHash('sha256')
    .update(canonicalJson({ runtimeId, payload }), 'utf8')
    .digest('hex');
}

function runtimeCommandConflict(id: string): Error & { code: string } {
  return Object.assign(
    new Error(`Runtime command ID ${id} belongs to a different command.`),
    { code: 'idempotency-conflict' },
  );
}

export class RuntimeService {
  private readonly runtimeCommandInFlight = new Map<
    string,
    { fingerprint: string; execution: Promise<unknown> }
  >();

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly manager: RuntimeManager,
    private readonly sessions: SessionIndex,
    private readonly repository?: OrchestrationRepository,
    private readonly onThreadActivity?: (threadId: string) => void,
  ) {}

  snapshots(): RuntimeSnapshot[] {
    return this.registry.snapshots();
  }

  async launch(input: unknown) {
    return this.manager.launch(input);
  }

  async command(runtimeId: string, input: unknown): Promise<unknown> {
    const sessionId = this.messageSessionId(runtimeId, input);
    const result = await this.registry.sendCommand(runtimeId, input);
    if (sessionId) {
      const id = (input as { id?: unknown }).id;
      this.unsettleSessionThread(
        sessionId,
        typeof id === 'string' ? id : `runtime-${Date.now()}`,
      );
    }
    return result;
  }

  private messageSessionId(
    runtimeId: string,
    input: unknown,
  ): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return undefined;
    const type = (input as { type?: unknown }).type;
    if (type !== 'prompt' && type !== 'steer') return undefined;
    return this.registry.get(runtimeId)?.session.id;
  }

  private unsettleSessionThread(sessionId: string, commandId: string): void {
    const repository = this.repository;
    if (!repository) return;
    const link = repository.getSessionThreadLink(sessionId);
    if (!link) return;
    const thread = repository.getThread(link.threadId);
    if (!thread) return;
    this.onThreadActivity?.(thread.id);
    if (thread.settledAt === undefined) return;
    repository.unsettleThread(`thread-activity-${commandId}`, thread.id);
  }

  /**
   * The one receipt boundary for live-state mutations. It deliberately stores
   * only a SHA-256 fingerprint and the bounded result; execution resolves the
   * current manager/registry/session state after dedupe has been checked.
   */
  private async executeWithReceipt<T>(options: {
    commandId: string;
    commandType: string;
    target?: string;
    runtimeId?: string;
    payload: unknown;
    execute: () => Promise<T>;
  }): Promise<{ status: 'completed' | 'already-completed'; result: T }> {
    const repository = this.repository;
    if (!repository)
      throw new Error('Runtime command receipts are unavailable.');
    const fingerprint = runtimeCommandFingerprint(
      options.target ?? '',
      options.payload,
    );
    const inFlightFingerprint = `${options.commandType}:${fingerprint}`;
    const existing = repository.getCommandReceipt(options.commandId);
    if (existing) {
      if (
        existing.commandType !== options.commandType ||
        (existing.runtimeId ?? undefined) !== options.runtimeId ||
        (existing.resourceId !== undefined &&
          existing.resourceId !== (options.target ?? undefined)) ||
        existing.commandFingerprint !== fingerprint
      )
        throw runtimeCommandConflict(options.commandId);
      return { status: 'already-completed', result: existing.result as T };
    }
    const inFlight = this.runtimeCommandInFlight.get(options.commandId);
    if (inFlight) {
      if (inFlight.fingerprint !== inFlightFingerprint)
        throw runtimeCommandConflict(options.commandId);
      return {
        status: 'already-completed',
        result: (await inFlight.execution) as T,
      };
    }
    const execution = (async () => {
      const result = await options.execute();
      const receipt: CommandReceipt = {
        idempotencyKey: options.commandId,
        commandType: options.commandType,
        ...(options.runtimeId === undefined
          ? {}
          : { runtimeId: options.runtimeId }),
        ...(options.target === undefined
          ? {}
          : { resourceType: 'runtime-lifecycle', resourceId: options.target }),
        commandFingerprint: fingerprint,
        result,
        createdAt: Date.now(),
      };
      repository.recordCommandReceipt(receipt);
      return result;
    })();
    this.runtimeCommandInFlight.set(options.commandId, {
      fingerprint: inFlightFingerprint,
      execution,
    });
    try {
      return { status: 'completed', result: await execution };
    } finally {
      if (
        this.runtimeCommandInFlight.get(options.commandId)?.execution ===
        execution
      )
        this.runtimeCommandInFlight.delete(options.commandId);
    }
  }

  /** Execute a browser command once and retain its acknowledged result. */
  async commandWithReceipt(
    runtimeId: string,
    input: BridgeCommand,
  ): Promise<RuntimeCommandOutput> {
    const command = validateBridgeCommand(input);
    const { id, ...payload } = command;
    const completion = await this.executeWithReceipt({
      commandId: id,
      commandType: 'runtime.command',
      target: runtimeId,
      runtimeId,
      payload,
      execute: async () => {
        // Registry lookup and connection selection happen only at execution
        // time; a receipt never authorizes a replacement runtime generation.
        const sessionId = this.messageSessionId(runtimeId, command);
        const acknowledged = await this.registry.sendCommand(
          runtimeId,
          command,
        );
        if (sessionId) this.unsettleSessionThread(sessionId, command.id);
        return acknowledged === undefined ? null : acknowledged;
      },
    });
    return {
      runtimeId,
      commandId: id,
      status: completion.status,
      result: completion.result,
    };
  }

  activateSession(sessionId: string, activityId: string): void {
    this.unsettleSessionThread(sessionId, activityId);
  }

  async startWithReceipt(value: unknown): Promise<StartRuntimeMutationOutput> {
    const input = parseStartRuntimeMutationInput(value);
    const { commandId, ...request } = input;
    const completion = await this.executeWithReceipt({
      commandId,
      commandType: 'runtime.start',
      target: input.checkoutId,
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      payload: request,
      execute: async () => {
        const launched = await this.manager.launch(request);
        return { runtimeId: launched.runtimeId };
      },
    });
    return { commandId, status: completion.status, result: completion.result };
  }

  async restartWithReceipt(
    value: unknown,
  ): Promise<RestartRuntimeMutationOutput> {
    const input = parseRestartRuntimeMutationInput(value);
    const completion = await this.executeWithReceipt({
      commandId: input.commandId,
      commandType: 'runtime.restart',
      target: input.runtimeId,
      runtimeId: input.runtimeId,
      payload: {},
      execute: async () => {
        // This check belongs inside the receipt execution. A failed
        // precondition does not consume the caller's command ID.
        if (!this.manager.canRestart(input.runtimeId))
          throw Object.assign(new Error('Only managed runtimes can restart.'), {
            code: 'restart-precondition',
          });
        const restarted = await this.manager.restart(input.runtimeId);
        return { runtimeId: restarted.runtimeId };
      },
    });
    return {
      commandId: input.commandId,
      status: completion.status,
      result: completion.result,
    };
  }

  async stopWithReceipt(value: unknown): Promise<StopRuntimeMutationOutput> {
    const input = parseStopRuntimeMutationInput(value);
    const completion = await this.executeWithReceipt({
      commandId: input.commandId,
      commandType: 'runtime.stop',
      target: input.runtimeId,
      runtimeId: input.runtimeId,
      payload: { force: input.force },
      execute: async () => {
        await this.manager.stop(input.runtimeId, input.force);
        return { runtimeId: input.runtimeId, stopped: true as const };
      },
    });
    return {
      commandId: input.commandId,
      status: completion.status,
      result: completion.result,
    };
  }

  async renameWithReceipt(
    value: unknown,
  ): Promise<RenameSessionMutationOutput> {
    const input = parseRenameSessionMutationInput(value);
    const completion = await this.executeWithReceipt({
      commandId: input.commandId,
      commandType: 'session.rename',
      target: input.sessionId,
      payload: { name: input.name },
      execute: async () => {
        // Resolve live-vs-dormant at execution time, not when the request was
        // queued. A response-loss retry therefore cannot rename twice.
        const runtime = this.registry
          .snapshots()
          .find(
            (item) =>
              item.session.id === input.sessionId && item.online !== false,
          );
        if (runtime) {
          await this.registry.sendCommand(runtime.runtimeId, {
            id: input.commandId,
            type: 'setSessionName',
            name: input.name,
          });
        } else {
          await this.sessions.rename(input.sessionId, input.name);
        }
        return { sessionId: input.sessionId, name: input.name };
      },
    });
    return {
      commandId: input.commandId,
      status: completion.status,
      result: completion.result,
    };
  }

  async stop(runtimeId: string, force = false): Promise<void> {
    await this.manager.stop(runtimeId, force);
  }

  async renameSession(id: string, name: string): Promise<unknown> {
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === id && item.online !== false);
    if (runtime)
      return this.registry.sendCommand(runtime.runtimeId, {
        type: 'setSessionName',
        name,
      });
    return this.sessions.rename(id, name);
  }
}
