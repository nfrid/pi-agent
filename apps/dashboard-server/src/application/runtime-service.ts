import { createHash } from 'node:crypto';
import { NonIdempotentActionIdGuard } from '@pi-dashboard/extension-contributions';
import {
  type BridgeCommand,
  type CommandReceipt,
  type RuntimeCommandOutput,
  type RuntimeSnapshot,
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
  private readonly restartCommandIds = new NonIdempotentActionIdGuard();
  private readonly runtimeCommandInFlight = new Map<
    string,
    { fingerprint: string; execution: Promise<unknown> }
  >();

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly manager: RuntimeManager,
    private readonly sessions: SessionIndex,
    private readonly repository?: OrchestrationRepository,
  ) {}

  snapshots(): RuntimeSnapshot[] {
    return this.registry.snapshots();
  }

  async launch(input: unknown) {
    return this.manager.launch(input);
  }

  async command(runtimeId: string, input: unknown): Promise<unknown> {
    return this.registry.sendCommand(runtimeId, input);
  }

  /** Execute a browser command once and retain its acknowledged result. */
  async commandWithReceipt(
    runtimeId: string,
    input: BridgeCommand,
  ): Promise<RuntimeCommandOutput> {
    const repository = this.repository;
    if (!repository)
      throw new Error('Runtime command receipts are unavailable.');
    const command = validateBridgeCommand(input);
    const { id, ...payload } = command;
    const fingerprint = runtimeCommandFingerprint(runtimeId, payload);
    const existing = repository.getCommandReceipt(id);
    if (existing) {
      if (
        existing.commandType !== 'runtime.command' ||
        existing.runtimeId !== runtimeId ||
        existing.commandFingerprint !== fingerprint
      )
        throw runtimeCommandConflict(id);
      return {
        runtimeId,
        commandId: id,
        status: 'already-completed',
        result: existing.result,
      };
    }
    const inFlight = this.runtimeCommandInFlight.get(id);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint)
        throw runtimeCommandConflict(id);
      return {
        runtimeId,
        commandId: id,
        status: 'already-completed',
        result: await inFlight.execution,
      };
    }
    const execution = (async () => {
      // Registry lookup and connection selection happen only at execution
      // time; a receipt never authorizes a replacement runtime generation.
      const acknowledged = await this.registry.sendCommand(runtimeId, command);
      const result = acknowledged === undefined ? null : acknowledged;
      const receipt: CommandReceipt = {
        idempotencyKey: id,
        commandType: 'runtime.command',
        runtimeId,
        commandFingerprint: fingerprint,
        result,
        createdAt: Date.now(),
      };
      repository.recordCommandReceipt(receipt);
      return result;
    })();
    this.runtimeCommandInFlight.set(id, { fingerprint, execution });
    try {
      return {
        runtimeId,
        commandId: id,
        status: 'completed',
        result: await execution,
      };
    } finally {
      if (this.runtimeCommandInFlight.get(id)?.execution === execution)
        this.runtimeCommandInFlight.delete(id);
    }
  }

  async stop(runtimeId: string, force = false): Promise<void> {
    await this.manager.stop(runtimeId, force);
  }

  async restart(runtimeId: string, commandId: string): Promise<unknown> {
    // Check the target before reserving replay memory. An unknown or external
    // runtime must remain retryable after the caller fixes its precondition.
    if (!this.manager.canRestart(runtimeId))
      throw Object.assign(new Error('Only managed runtimes can restart.'), {
        code: 'restart-precondition',
      });
    const reservation = this.restartCommandIds.reserve(commandId);
    if (reservation === 'duplicate')
      throw Object.assign(new Error('Duplicate restart command ID.'), {
        code: 'duplicate-action-id',
      });
    if (reservation === 'capacity')
      throw Object.assign(new Error('Restart command capacity is full.'), {
        code: 'action-command-capacity',
      });
    return this.manager.restart(runtimeId);
  }

  async answerInteraction(
    interactionId: string,
    answer: unknown,
    cancel = false,
  ): Promise<unknown> {
    const runtime = this.registry
      .snapshots()
      .find((item) =>
        item.pendingInteractions.some(
          (interaction) => interaction.id === interactionId,
        ),
      );
    if (!runtime)
      throw new Error('Interaction is already resolved or offline.');
    const interaction = runtime.pendingInteractions.find(
      (item) => item.id === interactionId,
    );
    const actionId = cancel
      ? (interaction?.cancelActionId ?? 'ask-user.cancel')
      : (interaction?.answerActionId ?? 'ask-user.answer');
    const advertisesAction = runtime.capabilities?.manifests.some((manifest) =>
      manifest.actions.some((action) => action.id === actionId),
    );
    // Protocol-v1 runtimes retain the original operation. New runtimes use the
    // contribution envelope; both paths resolve the same broker winner.
    return this.registry.sendCommand(
      runtime.runtimeId,
      advertisesAction
        ? {
            type: 'action.invoke',
            actionId,
            input: cancel ? { interactionId } : { interactionId, answer },
          }
        : cancel
          ? { type: 'interaction.cancel', interactionId }
          : { type: 'interaction.answer', interactionId, answer },
    );
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
