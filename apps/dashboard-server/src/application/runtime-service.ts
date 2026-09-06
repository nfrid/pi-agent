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
import type {
  RuntimeCommandIntent,
  RuntimeIntentPlan,
  RuntimeServiceRepository,
} from '../repositories/types.js';
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

function runtimeCommandUncertain(): Error & { code: string } {
  return Object.assign(
    new Error(
      'Command outcome is unknown. It was not replayed; inspect the runtime or session before issuing a new command.',
    ),
    { code: 'runtime-command-uncertain' },
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
    private readonly repository?: RuntimeServiceRepository,
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
    /** Preparation runs only after in-flight sharing and before reservation. */
    prepare?: () => Promise<void>;
    plan: RuntimeIntentPlan | (() => RuntimeIntentPlan);
    plannedRuntimeId?: string | (() => string | undefined);
    /** Persist the side-effect boundary before dispatching it. */
    beforeExecute?: (intent: RuntimeCommandIntent) => Promise<void>;
    /** Reconcile a non-prepared intent without replaying its side effect. */
    reconcile?: (intent: RuntimeCommandIntent) => Promise<T | undefined>;
    execute: (intent: RuntimeCommandIntent) => Promise<T>;
  }): Promise<{ status: 'completed' | 'already-completed'; result: T }> {
    const repository = this.repository;
    if (!repository)
      throw new Error('Runtime command receipts are unavailable.');
    if (
      !repository.reserveCommandIntent ||
      !repository.completeCommandIntent ||
      !repository.transitionCommandIntent ||
      !repository.getCommandIntent
    )
      throw new Error('Durable runtime command intents are unavailable.');
    const fingerprint = runtimeCommandFingerprint(
      options.target ?? '',
      options.payload,
    );
    const inFlightFingerprint = `${options.commandType}:${fingerprint}`;
    const existingIntent = repository.getCommandIntent(options.commandId);
    const existing = existingIntent;
    if (existing) {
      if (
        existing.commandType !== options.commandType ||
        (existing.runtimeId ?? undefined) !== options.runtimeId ||
        (existing.resourceId !== undefined &&
          existing.resourceId !== (options.target ?? undefined)) ||
        existing.commandFingerprint !== fingerprint
      )
        throw runtimeCommandConflict(options.commandId);
      if (existing.executionState === 'completed')
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

    let intent = existingIntent;
    const execution = (async () => {
      if (!intent) {
        await options.prepare?.();
        const plan =
          typeof options.plan === 'function' ? options.plan() : options.plan;
        if (!plan)
          throw new Error('Runtime command intent plan is unavailable.');
        const plannedRuntimeId =
          typeof options.plannedRuntimeId === 'function'
            ? options.plannedRuntimeId()
            : options.plannedRuntimeId;
        intent = repository.reserveCommandIntent({
          idempotencyKey: options.commandId,
          commandType: options.commandType,
          ...(options.target === undefined
            ? {}
            : {
                resourceType: 'runtime-lifecycle',
                resourceId: options.target,
              }),
          ...(options.runtimeId === undefined
            ? {}
            : { runtimeId: options.runtimeId }),
          commandFingerprint: fingerprint,
          executionPlan: plan,
          ...(plannedRuntimeId === undefined ? {} : { plannedRuntimeId }),
        });
      }
      if (intent) {
        if (intent.executionState === 'completed') return intent.result as T;
        if (intent.executionState !== 'prepared') {
          const reconciled = await options.reconcile?.(intent);
          if (reconciled !== undefined) {
            const receipt: CommandReceipt = {
              idempotencyKey: options.commandId,
              commandType: options.commandType,
              ...(options.runtimeId === undefined
                ? {}
                : { runtimeId: options.runtimeId }),
              ...(options.target === undefined
                ? {}
                : {
                    resourceType: 'runtime-lifecycle',
                    resourceId: options.target,
                  }),
              commandFingerprint: fingerprint,
              result: reconciled,
              createdAt: intent.createdAt,
            };
            repository.completeCommandIntent(receipt);
            return reconciled;
          }
          throw runtimeCommandUncertain();
        }
        await options.beforeExecute?.(intent);
      }
      const result = await options.execute(intent);
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
      repository.completeCommandIntent(receipt);
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

  /**
   * Reconcile durable intents after bridge/session startup and before HTTP is
   * opened. Prepared launches are deliberately left idle; an intent that has
   * crossed a side-effect boundary is either proven complete or marked
   * uncertain, never replayed speculatively.
   */
  async reconcilePendingIntents(): Promise<void> {
    const repository = this.repository;
    const pending = repository?.pendingCommandIntents();
    if (!repository || !pending) return;
    for (const intent of pending) {
      if (intent.executionState === 'prepared') continue;
      if (this.runtimeCommandInFlight.has(intent.idempotencyKey)) continue;
      const execution = this.reconcilePersistedIntent(intent);
      this.runtimeCommandInFlight.set(intent.idempotencyKey, {
        fingerprint: `${intent.commandType}:${intent.commandFingerprint ?? ''}`,
        execution,
      });
      try {
        await execution;
      } catch {
        // Startup must remain available when provider or storage evidence is
        // unavailable. The durable intent remains pending for a later retry.
      } finally {
        if (
          this.runtimeCommandInFlight.get(intent.idempotencyKey)?.execution ===
          execution
        )
          this.runtimeCommandInFlight.delete(intent.idempotencyKey);
      }
    }
  }

  private async reconcilePersistedIntent(
    intent: RuntimeCommandIntent,
  ): Promise<void> {
    const repository = this.repository;
    if (
      !repository?.completeCommandIntent ||
      !repository.transitionCommandIntent
    )
      return;
    const plan = intent.executionPlan;
    let result: unknown;
    if (
      (intent.commandType === 'runtime.start' ||
        intent.commandType === 'runtime.restart') &&
      (intent.executionState === 'launching' ||
        intent.executionState === 'stopping')
    ) {
      const replacementRuntimeId =
        intent.plannedRuntimeId ??
        plan?.replacementRuntimeId ??
        plan?.runtimeId;
      if (
        intent.commandType === 'runtime.restart' &&
        intent.executionState === 'stopping' &&
        replacementRuntimeId
      ) {
        if (
          plan?.oldRuntimeId &&
          this.manager.reconcileStop(plan.oldRuntimeId) === true
        ) {
          await repository.transitionCommandIntent(
            intent.idempotencyKey,
            'launching',
          );
          const launched = await this.manager.launch(
            this.launchRequestFromPlan(plan, replacementRuntimeId),
            {
              owningIntentId: intent.idempotencyKey,
              sessionFile: plan?.sessionFile,
            },
          );
          result = { runtimeId: launched.runtimeId };
        }
      } else if (replacementRuntimeId) {
        if (this.manager.reconcileLaunch(replacementRuntimeId) === 'ready')
          result = { runtimeId: replacementRuntimeId };
      }
    } else if (
      intent.commandType === 'runtime.stop' &&
      intent.executionState === 'dispatched'
    ) {
      if (
        plan?.runtimeId &&
        this.manager.reconcileStop(plan.runtimeId) === true
      )
        result = { runtimeId: plan.runtimeId, stopped: true as const };
    }
    if (result === undefined) {
      await repository.transitionCommandIntent(
        intent.idempotencyKey,
        'uncertain',
      );
      return;
    }
    repository.completeCommandIntent({
      idempotencyKey: intent.idempotencyKey,
      commandType: intent.commandType,
      ...(intent.runtimeId === undefined
        ? {}
        : { runtimeId: intent.runtimeId }),
      ...(intent.resourceType === undefined
        ? {}
        : { resourceType: intent.resourceType }),
      ...(intent.resourceId === undefined
        ? {}
        : { resourceId: intent.resourceId }),
      ...(intent.commandFingerprint === undefined
        ? {}
        : { commandFingerprint: intent.commandFingerprint }),
      result,
      createdAt: intent.createdAt,
    });
  }

  private launchRequestFromPlan(
    plan: RuntimeIntentPlan | undefined,
    runtimeId: string,
  ): Record<string, unknown> {
    if (plan?.operation === 'restart' && (!plan.sessionId || !plan.sessionFile))
      throw new Error('Restart intent is missing exact session evidence.');
    return {
      ...(plan?.projectId ? { projectId: plan.projectId } : {}),
      ...(plan?.checkoutId ? { checkoutId: plan.checkoutId } : {}),
      ...(plan?.cwd ? { checkoutCwd: plan.cwd } : {}),
      ...(plan?.sessionId ? { sessionId: plan.sessionId } : {}),
      ...(plan?.name ? { name: plan.name } : {}),
      ...(plan?.mode ? { mode: plan.mode } : {}),
      ...(plan?.model ? { model: plan.model } : {}),
      ...(plan?.runtimeProvider
        ? { runtimeProvider: plan.runtimeProvider }
        : {}),
      runtimeId,
    };
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
      plan: { operation: 'command', runtimeId },
      beforeExecute: async () => {
        await this.repository?.transitionCommandIntent(id, 'dispatched');
      },
      execute: async () => {
        // Registry lookup and connection selection happen only at execution
        // time; a receipt never authorizes a replacement runtime generation.
        const sessionId = this.messageSessionId(runtimeId, command);
        const acknowledged = await this.registry.sendCommand(
          runtimeId,
          command,
        );
        if (
          acknowledged &&
          typeof acknowledged === 'object' &&
          'commandId' in acknowledged &&
          'runtimeId' in acknowledged &&
          'status' in acknowledged
        )
          throw new Error(
            'Bridge acknowledgement must not impersonate a command receipt.',
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
    let preparedLaunch:
      | Awaited<ReturnType<RuntimeManager['prepareLaunch']>>
      | undefined;
    const completion = await this.executeWithReceipt({
      commandId,
      commandType: 'runtime.start',
      target: input.checkoutId,
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      payload: request,
      prepare: async () => {
        preparedLaunch = await this.manager.prepareLaunch(request);
      },
      plan: () => {
        const prepared = preparedLaunch;
        return {
          operation: 'start',
          runtimeId: prepared?.runtimeId ?? input.runtimeId,
          projectId: prepared?.projectId ?? input.projectId,
          checkoutId: prepared?.checkoutId ?? input.checkoutId,
          ...(prepared?.cwd === undefined ? {} : { cwd: prepared.cwd }),
          ...(prepared?.sessionFile === undefined
            ? {}
            : { sessionFile: prepared.sessionFile }),
          ...(input.sessionId === undefined
            ? {}
            : { sessionId: input.sessionId }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(prepared?.runtimeProvider === undefined
            ? {}
            : { runtimeProvider: prepared.runtimeProvider }),
        };
      },
      plannedRuntimeId: () => preparedLaunch?.runtimeId ?? input.runtimeId,
      reconcile: async (intent) => {
        if (intent.executionState !== 'launching') return undefined;
        const runtimeId =
          intent.plannedRuntimeId ?? intent.executionPlan?.runtimeId;

        if (!runtimeId) return undefined;
        return this.manager.reconcileLaunch(runtimeId) === 'ready'
          ? { runtimeId }
          : undefined;
      },
      beforeExecute: async () => {
        await this.repository?.transitionCommandIntent(commandId, 'launching');
      },
      execute: async (intent) => {
        const plan = intent?.executionPlan;
        const runtimeId =
          intent?.plannedRuntimeId ??
          plan?.runtimeId ??
          preparedLaunch?.runtimeId ??
          input.runtimeId;
        if (!runtimeId)
          throw new Error('Runtime intent identity is unavailable.');
        const launchRequest = {
          ...this.launchRequestFromPlan(plan, runtimeId),
          ...(request.initialPrompt
            ? { initialPrompt: request.initialPrompt }
            : {}),
        };
        const launched = await this.manager.launch(launchRequest, {
          owningIntentId: commandId,
          sessionFile: plan?.sessionFile,
        });
        return { runtimeId: launched.runtimeId };
      },
    });
    return { commandId, status: completion.status, result: completion.result };
  }

  async restartWithReceipt(
    value: unknown,
  ): Promise<RestartRuntimeMutationOutput> {
    const input = parseRestartRuntimeMutationInput(value);
    let preparedRestart:
      | Awaited<ReturnType<RuntimeManager['prepareRestart']>>
      | undefined;
    const completion = await this.executeWithReceipt({
      commandId: input.commandId,
      commandType: 'runtime.restart',
      target: input.runtimeId,
      runtimeId: input.runtimeId,
      payload: {},
      prepare: async () => {
        if (!this.manager.canRestart(input.runtimeId))
          throw Object.assign(new Error('Only managed runtimes can restart.'), {
            code: 'restart-precondition',
          });
        preparedRestart = await this.manager.prepareRestart(input.runtimeId);
      },
      plan: () => {
        const prepared = preparedRestart;
        const request = prepared?.request;
        return {
          operation: 'restart',
          oldRuntimeId: input.runtimeId,
          runtimeId: input.runtimeId,
          replacementRuntimeId: prepared?.replacementRuntimeId,
          ...(request?.projectId === undefined
            ? {}
            : { projectId: String(request.projectId) }),
          ...(request?.checkoutId === undefined
            ? {}
            : { checkoutId: String(request.checkoutId) }),
          ...(request?.checkoutCwd === undefined
            ? {}
            : { cwd: String(request.checkoutCwd) }),
          ...(request?.sessionId === undefined
            ? {}
            : { sessionId: String(request.sessionId) }),
          ...(prepared?.sessionFile === undefined
            ? {}
            : { sessionFile: prepared.sessionFile }),
          ...(request?.name === undefined
            ? {}
            : { name: String(request.name) }),
          ...(request?.mode === 'read' || request?.mode === 'write'
            ? { mode: request.mode }
            : {}),
          ...(request?.runtimeProvider === undefined
            ? {}
            : { runtimeProvider: String(request.runtimeProvider) }),
          ...(request?.model && typeof request.model === 'object'
            ? {
                model: request.model as RuntimeIntentPlan['model'],
              }
            : {}),
        };
      },
      plannedRuntimeId: () => preparedRestart?.replacementRuntimeId,
      beforeExecute: async () => {
        await this.repository?.transitionCommandIntent(
          input.commandId,
          'stopping',
        );
      },
      reconcile: async (intent) => {
        const plan = intent.executionPlan;
        const replacementRuntimeId =
          intent.plannedRuntimeId ?? plan?.replacementRuntimeId;
        if (!replacementRuntimeId) return undefined;
        if (intent.executionState === 'stopping') {
          if (!this.manager.reconcileStop(input.runtimeId)) return undefined;
          await this.repository?.transitionCommandIntent(
            input.commandId,
            'launching',
          );
          const launched = await this.manager.launch(
            this.launchRequestFromPlan(plan, replacementRuntimeId),
            { owningIntentId: input.commandId, sessionFile: plan?.sessionFile },
          );
          return { runtimeId: launched.runtimeId };
        }

        return this.manager.reconcileLaunch(replacementRuntimeId) === 'ready'
          ? { runtimeId: replacementRuntimeId }
          : undefined;
      },
      execute: async (intent) => {
        const plan = intent?.executionPlan;
        const replacementRuntimeId =
          intent?.plannedRuntimeId ??
          plan?.replacementRuntimeId ??
          preparedRestart?.replacementRuntimeId;
        if (!replacementRuntimeId)
          throw new Error(
            'Replacement runtime intent identity is unavailable.',
          );
        const request = this.launchRequestFromPlan(plan, replacementRuntimeId);
        const context = {
          owningIntentId: input.commandId,
          sessionFile: plan?.sessionFile,
        };
        await this.manager.prepareLaunch(request, {
          ...context,
          restartingRuntimeId: input.runtimeId,
        });
        await this.manager.stop(input.runtimeId);
        await this.repository?.transitionCommandIntent(
          input.commandId,
          'launching',
        );
        const launched = await this.manager.launch(request, context);
        return { runtimeId: launched.runtimeId };
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
      prepare: async () => {
        if (!this.manager.canStop(input.runtimeId))
          throw new Error('Unknown runtime.');
      },
      plan: {
        operation: 'stop',
        runtimeId: input.runtimeId,
        force: input.force,
      },
      beforeExecute: async () => {
        await this.repository?.transitionCommandIntent(
          input.commandId,
          'dispatched',
        );
      },
      reconcile: async () => {
        return this.manager.reconcileStop(input.runtimeId)
          ? { runtimeId: input.runtimeId, stopped: true as const }
          : undefined;
      },
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
      plan: { operation: 'rename', sessionId: input.sessionId },
      beforeExecute: async () => {
        await this.repository?.transitionCommandIntent(
          input.commandId,
          'dispatched',
        );
      },
      // A lost rename acknowledgement is intentionally not replayed: neither
      // a bridge command nor a dormant-session write has durable ACK evidence.
      reconcile: async () => undefined,
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
