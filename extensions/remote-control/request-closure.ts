import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  RESPONSE_CLOSURE_MARKER_TYPE,
  type ResponseClosure,
  type ResponseClosureMarker,
  tryParseResponseClosure,
} from '@pi-dashboard/protocol';
import { type Static, Type } from 'typebox';

type NativeMessage = Record<string, unknown>;
type TrackedMessage = { message: NativeMessage; liveId?: string };
type WaitTarget = Static<typeof WaitTargets>[number];
type CanonicalWaitTarget =
  | { kind: 'process'; id: string }
  | { kind: 'watch'; id: string; watchId: string }
  | { kind: 'delegate'; id: string };

function epochMilliseconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageFrom(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.message) ? value.message : value;
}

function waitTargetKey(target: CanonicalWaitTarget): string {
  return target.kind === 'watch'
    ? `watch:${target.id}:${target.watchId}`
    : `${target.kind}:${target.id}`;
}

function resultKeys(
  values: readonly unknown[],
  delegateAliases: ReadonlyMap<string, string>,
): Set<string> {
  const keys = new Set<string>();
  const addDelegate = (value: unknown) => {
    if (typeof value !== 'string') return;
    const identity = delegateAliases.get(value);
    if (identity) keys.add(`delegate:${identity}`);
  };
  for (const value of values) {
    const message = messageFrom(value);
    if (!message) continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) continue;
    if (message.customType === 'background-terminal-result') {
      if (typeof details.id === 'string') keys.add(`process:${details.id}`);
      if (typeof details.id === 'string' && Array.isArray(details.endedWatches))
        for (const watch of details.endedWatches)
          if (isRecord(watch) && typeof watch.id === 'string')
            keys.add(`watch:${details.id}:${watch.id}`);
    } else if (
      message.customType === 'background-watch-result' &&
      typeof details.id === 'string' &&
      typeof details.watchId === 'string'
    ) {
      keys.add(`watch:${details.id}:${details.watchId}`);
    } else if (
      message.role === 'toolResult' &&
      message.toolName === 'background_stop' &&
      details.action === 'stop' &&
      Array.isArray(details.processes)
    ) {
      for (const process of details.processes) {
        if (
          !isRecord(process) ||
          typeof process.id !== 'string' ||
          !['done', 'failed', 'killed'].includes(String(process.status))
        )
          continue;
        keys.add(`process:${process.id}`);
        if (Array.isArray(process.watches))
          for (const watch of process.watches)
            if (isRecord(watch) && typeof watch.id === 'string')
              keys.add(`watch:${process.id}:${watch.id}`);
      }
    } else if (
      message.customType === 'delegate-job-result' &&
      Array.isArray(details.jobs)
    ) {
      for (const job of details.jobs) {
        if (!isRecord(job)) continue;
        addDelegate(job.attemptIdentity);
        addDelegate(job.id);
      }
    } else if (
      message.role === 'toolResult' &&
      message.toolName === 'delegate_jobs' &&
      details.action === 'cancel'
    ) {
      if (Array.isArray(details.attempts))
        for (const attempt of details.attempts)
          if (
            isRecord(attempt) &&
            ['cancelled', 'completed', 'failed'].includes(String(attempt.state))
          )
            addDelegate(attempt.identity);
      if (Array.isArray(details.jobs))
        for (const job of details.jobs)
          if (
            isRecord(job) &&
            ['cancelled', 'success', 'error'].includes(String(job.state))
          ) {
            addDelegate(job.attemptIdentity);
            addDelegate(job.id);
          }
    }
  }
  return keys;
}

/** Binds request boundaries only through native message object identity. */
export class RequestClosureLifecycle {
  private sessionId?: string;
  private request?: TrackedMessage;
  private final?: TrackedMessage;
  private marker?: ResponseClosure;
  private settledMarker?: ResponseClosureMarker;
  private readonly waiting = new Set<string>();
  private previousRequest?: TrackedMessage;
  private previousFinal?: TrackedMessage;
  private readonly delegateAliases = new Map<string, string>();
  private readonly startReceipts = new Map<string, NativeMessage>();
  private readonly receiptIds = new Set<string>();
  private steeredMessages = new WeakSet<object>();
  private previousWaiting: string[] = [];

  observe(sessionId: string, message: NativeMessage): void {
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.request = undefined;
      this.final = undefined;
      this.marker = undefined;
      this.settledMarker = undefined;
      this.waiting.clear();
      this.delegateAliases.clear();
      this.startReceipts.clear();
      this.receiptIds.clear();
    }
    if (this.steeredMessages.has(message)) return;
    if (this.request?.message === message) return;
    if (this.final?.message === message) return;
    if (message.role === 'user') {
      const data = message.data;
      const deliveryMode =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>).deliveryMode
          : undefined;
      if (deliveryMode !== 'steer') {
        this.previousRequest = this.request;
        this.previousFinal = this.final;
        this.previousWaiting = [...this.waiting];
        this.request = { message };
        this.final = undefined;
        this.marker = undefined;
        this.waiting.clear();
        this.delegateAliases.clear();
      }
    } else if (message.role === 'assistant' && this.request) {
      this.final = { message };
    }
  }

  observeToolReceipt(
    sessionId: string,
    receiptId: string,
    toolName: string,
    result: unknown,
    parentToolCallId?: string,
  ): void {
    if (sessionId !== this.sessionId) {
      this.observe(sessionId, { role: 'system' });
    }
    if (this.receiptIds.has(receiptId)) return;
    this.receiptIds.add(receiptId);
    if (this.receiptIds.size > 128) {
      const oldest = this.receiptIds.values().next().value;
      if (oldest) this.receiptIds.delete(oldest);
    }
    const message = isRecord(result) ? result : undefined;
    if (!message || !isRecord(message.details)) return;
    if (this.startReceipts.size >= 128) {
      const oldest = this.startReceipts.keys().next().value;
      if (oldest) this.startReceipts.delete(oldest);
    }
    this.startReceipts.set(receiptId, {
      role: 'toolResult',
      toolCallId: receiptId,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      toolName,
      details: message.details,
    });
  }

  getToolReceipts(): NativeMessage[] {
    return [...this.startReceipts.values()];
  }

  private enteredResultEvidence(messages: readonly unknown[]): unknown[] {
    const enteredCalls = new Set<string>();
    for (const value of messages) {
      const message = messageFrom(value);
      if (message?.role !== 'toolResult') continue;
      if (typeof message.toolCallId === 'string')
        enteredCalls.add(message.toolCallId);
      const nested = message.nestedCalls;
      if (isRecord(nested) && Array.isArray(nested.calls))
        for (const call of nested.calls)
          if (isRecord(call) && typeof call.id === 'string')
            enteredCalls.add(call.id);
    }
    return [
      ...messages,
      ...this.getToolReceipts().filter(
        (receipt) =>
          typeof receipt.parentToolCallId === 'string' &&
          (enteredCalls.has(String(receipt.toolCallId)) ||
            enteredCalls.has(receipt.parentToolCallId)),
      ),
    ];
  }

  observeLiveAlias(message: NativeMessage, liveId: string): void {
    if (this.request?.message === message) this.request.liveId = liveId;
    if (this.final?.message === message) this.final.liveId = liveId;
  }

  markSteer(message: NativeMessage): void {
    this.steeredMessages.add(message);
    if (this.request?.message !== message) return;
    this.request = this.previousRequest;
    this.final = this.previousFinal;
    this.marker = undefined;
    this.waiting.clear();
    for (const target of this.previousWaiting) this.waiting.add(target);
    this.previousRequest = undefined;
    this.previousFinal = undefined;
    this.previousWaiting = [];
  }

  wait(
    targets: readonly CanonicalWaitTarget[],
    delegateAliases: ReadonlyMap<string, string>,
    history: readonly unknown[],
  ): void {
    for (const [alias, identity] of delegateAliases)
      this.delegateAliases.set(alias, identity);
    const resolved = resultKeys(
      this.enteredResultEvidence(history),
      this.delegateAliases,
    );
    for (const key of resolved) this.waiting.delete(key);
    for (const target of targets) {
      const key = waitTargetKey(target);
      if (!resolved.has(key)) this.waiting.add(key);
    }
  }

  entered(messages: readonly unknown[]): void {
    for (const key of resultKeys(
      this.enteredResultEvidence(messages),
      this.delegateAliases,
    ))
      this.waiting.delete(key);
  }

  beforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext) {
    this.marker = undefined;
    const queuedResult = event.context.pendingMessages.some((message) => {
      if (message.role !== 'custom') return false;
      const type = message.customType;
      return (
        type === 'background-terminal-result' ||
        type === 'background-watch-result' ||
        type === 'delegate-job-result' ||
        type === 'delegate-wake-result'
      );
    });
    if (
      queuedResult ||
      event.continue ||
      event.outcome !== 'completed' ||
      ctx.sessionManager.getSessionId() !== this.sessionId ||
      this.waiting.size
    )
      return;
    const request = this.request;
    const final = this.final;
    if (!request || !final) return;
    const branch = ctx.sessionManager.getBranch();
    const exactEntry = (message: NativeMessage) => {
      const found = branch.filter(
        (entry) => entry.type === 'message' && entry.message === message,
      );
      return found.length === 1 ? found[0] : undefined;
    };
    const requestEntry = exactEntry(request.message);
    const finalEntry = exactEntry(final.message);
    const startedAt = epochMilliseconds(requestEntry?.timestamp);
    const endedAt = epochMilliseconds(finalEntry?.timestamp);
    if (
      !requestEntry?.id ||
      !finalEntry?.id ||
      startedAt === undefined ||
      endedAt === undefined
    )
      return;
    const closure = tryParseResponseClosure({
      requestMessageId: requestEntry.id,
      finalMessageId: finalEntry.id,
      startedAt,
      endedAt,
      ...(request.liveId ? { liveRequestMessageId: request.liveId } : {}),
      ...(final.liveId ? { liveFinalMessageId: final.liveId } : {}),
    });
    this.marker = closure;
  }

  persistedMarker(
    ctx: ExtensionContext,
    appendEntry: (customType: string, data: unknown) => void,
  ): ResponseClosureMarker | undefined {
    const marker = this.marker;
    if (
      marker &&
      this.waiting.size === 0 &&
      ctx.sessionManager.getSessionId() === this.sessionId
    ) {
      try {
        appendEntry(RESPONSE_CLOSURE_MARKER_TYPE, marker);
      } catch {
        this.marker = undefined;
      }
    }
    const entries =
      marker &&
      this.waiting.size === 0 &&
      ctx.sessionManager.getSessionId() === this.sessionId
        ? ctx.sessionManager.getBranch().filter((entry) => {
            if (
              entry.type !== 'custom' ||
              entry.customType !== RESPONSE_CLOSURE_MARKER_TYPE
            )
              return false;
            return JSON.stringify(entry.data) === JSON.stringify(marker);
          })
        : [];
    const entry = entries[0];
    const result: ResponseClosureMarker | undefined =
      marker && entries.length === 1 && entry?.id
        ? {
            id: entry.id,
            ...(typeof entry.parentId === 'string' || entry.parentId === null
              ? { parentId: entry.parentId }
              : {}),
            ...(typeof entry.timestamp === 'string'
              ? { timestamp: entry.timestamp }
              : {}),
            type: 'custom',
            customType: RESPONSE_CLOSURE_MARKER_TYPE,
            data: marker,
          }
        : undefined;
    this.settledMarker = result;
    if (!this.waiting.size) {
      this.request = undefined;
      this.final = undefined;
      this.marker = undefined;
      this.delegateAliases.clear();
    }
    return result;
  }

  takeSettledMarker(ctx: ExtensionContext): ResponseClosureMarker | undefined {
    if (ctx.sessionManager.getSessionId() !== this.sessionId) return undefined;
    const marker = this.settledMarker;
    this.settledMarker = undefined;
    return marker;
  }

  hasPendingWait(ctx: ExtensionContext): boolean {
    return (
      ctx.sessionManager.getSessionId() === this.sessionId &&
      this.waiting.size > 0
    );
  }

  reset(): void {
    this.sessionId = undefined;
    this.request = undefined;
    this.final = undefined;
    this.marker = undefined;
    this.settledMarker = undefined;
    this.waiting.clear();
    this.delegateAliases.clear();
    this.startReceipts.clear();
    this.receiptIds.clear();
    this.previousRequest = undefined;
    this.previousFinal = undefined;
    this.previousWaiting = [];
    this.steeredMessages = new WeakSet<object>();
  }
}

const WaitTargets = Type.Array(
  Type.Union([
    Type.Object(
      { kind: Type.Literal('process'), id: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('watch'),
        id: Type.String({ minLength: 1 }),
        watchId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal('delegate'), id: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
  ]),
  { minItems: 1, maxItems: 32 },
);

function canonicalizeWaitTargets(
  requested: readonly WaitTarget[],
  branch: readonly unknown[],
): { targets: CanonicalWaitTarget[]; delegateAliases: Map<string, string> } {
  const processes = new Set<string>();
  const watches = new Set<string>();
  const delegateRefs = new Map<string, Set<string>>();
  const rememberDelegate = (
    identity: unknown,
    logicalId?: unknown,
    jobId?: unknown,
  ) => {
    if (typeof identity !== 'string' || !identity) return;
    for (const ref of [identity, logicalId, jobId]) {
      if (typeof ref !== 'string' || !ref) continue;
      const identities = delegateRefs.get(ref) ?? new Set<string>();
      identities.add(identity);
      delegateRefs.set(ref, identities);
    }
  };

  for (const entry of branch) {
    const message = messageFrom(entry);
    if (message?.role !== 'toolResult') continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) continue;
    const addProcess = (process: unknown) => {
      if (!isRecord(process) || typeof process.id !== 'string') return;
      processes.add(process.id);
      if (Array.isArray(process.watches))
        for (const watch of process.watches)
          if (isRecord(watch) && typeof watch.id === 'string')
            watches.add(`${process.id}:${watch.id}`);
    };
    if (
      (message.toolName === 'background_start' ||
        message.toolName === 'background_watch') &&
      isRecord(details.process)
    )
      addProcess(details.process);
    if (
      message.toolName === 'background_list' &&
      Array.isArray(details.processes)
    )
      for (const process of details.processes) addProcess(process);
    if (
      (message.toolName === 'delegate_start' ||
        message.toolName === 'delegate_continue') &&
      isRecord(details.workflow)
    ) {
      rememberDelegate(
        details.workflow.identity,
        details.workflow.logicalId,
        details.workflow.jobId,
      );
    }
  }

  const aliases = new Map<string, string>();
  for (const [ref, identities] of delegateRefs) {
    if (identities.size !== 1) continue;
    const [identity] = identities;
    if (identity) aliases.set(ref, identity);
  }
  const targets: CanonicalWaitTarget[] = [];
  for (const target of requested) {
    if (target.kind === 'process') {
      if (!processes.has(target.id))
        throw new Error(
          `Unknown background process wait target "${target.id}".`,
        );
      targets.push({ kind: 'process', id: target.id });
    } else if (target.kind === 'watch') {
      if (!watches.has(`${target.id}:${target.watchId}`))
        throw new Error(
          `Unknown background watch wait target "${target.id}:${target.watchId}".`,
        );
      targets.push({ kind: 'watch', id: target.id, watchId: target.watchId });
    } else {
      const identities = delegateRefs.get(target.id);
      if (!identities?.size)
        throw new Error(`Unknown delegate wait target "${target.id}".`);
      if (identities.size !== 1)
        throw new Error(`Ambiguous delegate wait target "${target.id}".`);
      const identity = [...identities][0];
      if (!identity)
        throw new Error(`Unknown delegate wait target "${target.id}".`);
      targets.push({ kind: 'delegate', id: identity });
    }
  }
  return {
    targets: [
      ...new Map(
        targets.map((target) => [waitTargetKey(target), target]),
      ).values(),
    ],
    delegateAliases: aliases,
  };
}

export function installRequestClosureBoundary(
  pi: ExtensionAPI,
  lifecycle: RequestClosureLifecycle,
): void {
  pi.registerTool({
    name: 'response_wait',
    label: 'Wait for background results',
    description:
      'Keep this user request open for exact background process, output watch, or delegate IDs. Call with IDs returned by their start tools. A watch match resolves independently of its still-running process.',
    parameters: Type.Object(
      { targets: WaitTargets },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      const resolved = canonicalizeWaitTargets(params.targets, [
        ...branch,
        ...lifecycle.getToolReceipts(),
      ]);
      lifecycle.wait(resolved.targets, resolved.delegateAliases, branch);
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Waiting intent recorded for the named targets. Continue other useful work, then hand off when ready.',
          },
        ],
        details: { targets: resolved.targets },
      };
    },
  });
  pi.on('tool_execution_end', (event, ctx) => {
    const toolName = event.toolName;
    if (
      ![
        'background_start',
        'background_watch',
        'background_list',
        'background_stop',
        'delegate_start',
        'delegate_continue',
        'delegate_jobs',
      ].includes(toolName)
    )
      return;
    const sessionId = ctx.sessionManager.getSessionId();
    lifecycle.observeToolReceipt(
      sessionId,
      event.toolCallId,
      toolName,
      event.result,
      event.parentToolCallId,
    );
  });
  pi.on('message_end', (event, ctx) => {
    const message = messageFrom(event);
    if (message) lifecycle.observe(ctx.sessionManager.getSessionId(), message);
  });
  pi.on('context', (event) => lifecycle.entered(event.messages));
  pi.on('session_start', () => lifecycle.reset());
  pi.on('agent_before_settle', (event, ctx) =>
    lifecycle.beforeSettle(event, ctx),
  );
  pi.on('agent_settled', (_event, ctx) => {
    lifecycle.persistedMarker(ctx, (customType, data) =>
      pi.appendEntry(customType, data),
    );
  });
  pi.on('session_shutdown', () => lifecycle.reset());
}
