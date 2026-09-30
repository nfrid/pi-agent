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
import {
  forgetLogicalInput,
  installLogicalInputShim,
  isLogicalSteering,
  REQUEST_STEERING_ENTRY_TYPE,
  releaseLogicalFollowUps,
} from '../shared/runtime/logical-input';
import { getScopedServices } from '../shared/runtime/scoped-services';

type NativeMessage = Record<string, unknown>;
type DependencyKind = 'process' | 'watch' | 'delegate';
type Dependency = { kind: DependencyKind; id: string };
type TrackedMessage = { message: NativeMessage; liveId?: string };
type RequestDependencyContext = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): unknown[];
  };
};
export const REQUEST_DEPENDENCY_ENTRY_TYPE = 'request-dependency:v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageFrom(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.message) ? value.message : value;
}

function steeringEntryIds(branch: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== 'custom' || !isRecord(entry.data))
      continue;
    if (entry.customType === REQUEST_STEERING_ENTRY_TYPE) {
      if (typeof entry.data.userEntryId === 'string')
        ids.add(entry.data.userEntryId);
    }
  }
  return ids;
}

function hasAmbiguousSteering(branch: readonly unknown[]): boolean {
  return branch.some(
    (entry) =>
      isRecord(entry) &&
      entry.type === 'custom' &&
      entry.customType === REQUEST_STEERING_ENTRY_TYPE &&
      (!isRecord(entry.data) || typeof entry.data.userEntryId !== 'string'),
  );
}

function key(kind: DependencyKind, id: string): string {
  return `${kind}:${id}`;
}

function terminalProcessStatus(value: unknown): boolean {
  return value === 'done' || value === 'failed' || value === 'killed';
}

function resultKeys(values: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const value of values) {
    const message = messageFrom(value);
    if (!message) continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) continue;
    if (
      message.customType === 'background-terminal-result' &&
      typeof details.id === 'string' &&
      terminalProcessStatus(details.status)
    ) {
      keys.add(key('process', details.id));
      if (Array.isArray(details.endedWatches))
        for (const watch of details.endedWatches)
          if (
            isRecord(watch) &&
            typeof watch.id === 'string' &&
            (watch.status === undefined ||
              ['matched', 'timed_out', 'ended'].includes(String(watch.status)))
          )
            keys.add(key('watch', `${details.id}:${watch.id}`));
    } else if (
      message.customType === 'background-watch-result' &&
      typeof details.id === 'string' &&
      typeof details.watchId === 'string' &&
      ['matched', 'timed_out', 'ended'].includes(String(details.status))
    ) {
      keys.add(key('watch', `${details.id}:${details.watchId}`));
    } else if (
      message.role === 'toolResult' &&
      message.toolName === 'background_stop' &&
      details.action === 'stop' &&
      Array.isArray(details.processes)
    ) {
      for (const process of details.processes) {
        if (!isRecord(process) || !terminalProcessStatus(process.status))
          continue;
        if (typeof process.id !== 'string') continue;
        keys.add(key('process', process.id));
        if (Array.isArray(process.watches))
          for (const watch of process.watches)
            if (isRecord(watch) && typeof watch.id === 'string')
              keys.add(key('watch', `${process.id}:${watch.id}`));
      }
    } else if (
      message.role === 'toolResult' &&
      message.toolName === 'background_unwatch' &&
      details.action === 'unwatch' &&
      typeof details.id === 'string' &&
      Array.isArray(details.watchIds)
    ) {
      for (const watchId of details.watchIds)
        if (typeof watchId === 'string')
          keys.add(key('watch', `${details.id}:${watchId}`));
    } else if (
      message.role === 'toolResult' &&
      message.toolName === 'delegate_jobs' &&
      details.action === 'cancel'
    ) {
      if (Array.isArray(details.attempts))
        for (const attempt of details.attempts)
          if (
            isRecord(attempt) &&
            [
              'cancelled',
              'completed',
              'failed',
              'success',
              'error',
              'timed-out',
              'aborted',
              'blocked',
            ].includes(String(attempt.state)) &&
            typeof attempt.identity === 'string'
          )
            keys.add(key('delegate', attempt.identity));
      if (Array.isArray(details.jobs))
        for (const job of details.jobs)
          if (
            isRecord(job) &&
            [
              'cancelled',
              'success',
              'error',
              'aborted',
              'timed-out',
              'blocked',
            ].includes(String(job.state))
          ) {
            if (typeof job.attemptIdentity === 'string')
              keys.add(key('delegate', job.attemptIdentity));
            else if (typeof job.id === 'string')
              keys.add(key('delegate', job.id));
          }
    }
  }
  return keys;
}

function exactMessageEntry(
  branch: readonly unknown[],
  message: NativeMessage,
): Record<string, unknown> | undefined {
  const entries = branch.filter((entry) => {
    if (!isRecord(entry) || entry.type !== 'message') return false;
    return entry.message === message;
  });
  if (entries.length !== 1) return undefined;
  const [entry] = entries;
  return isRecord(entry) ? entry : undefined;
}

type DependencyRecord =
  | {
      operation: 'register' | 'resolve';
      sessionId: string;
      requestMessageId: string;
      kind: DependencyKind;
      id: string;
    }
  | {
      operation: 'abandon-request';
      sessionId: string;
      requestMessageId: string;
    };

function dependencyRecord(value: unknown): DependencyRecord | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (
    typeof value.sessionId !== 'string' ||
    typeof value.requestMessageId !== 'string'
  )
    return undefined;
  if (value.operation === 'abandon-request')
    return {
      operation: 'abandon-request',
      sessionId: value.sessionId,
      requestMessageId: value.requestMessageId,
    };
  if (
    (value.operation !== 'register' && value.operation !== 'resolve') ||
    (value.kind !== 'process' &&
      value.kind !== 'watch' &&
      value.kind !== 'delegate') ||
    typeof value.id !== 'string' ||
    !value.id
  )
    return undefined;
  return {
    operation: value.operation,
    sessionId: value.sessionId,
    requestMessageId: value.requestMessageId,
    kind: value.kind,
    id: value.id,
  };
}

/** Binds request boundaries and background dependencies to native branch identity. */
export class RequestClosureLifecycle {
  private sessionId?: string;
  private request?: TrackedMessage;
  private final?: TrackedMessage;
  private marker?: ResponseClosure;
  private settledMarker?: ResponseClosureMarker;
  private readonly waiting = new Map<string, Dependency>();
  private previousRequest?: TrackedMessage;
  private previousFinal?: TrackedMessage;
  private previousWaiting = new Map<string, Dependency>();
  private steeredMessages = new WeakSet<object>();
  private readonly controlReceipts = new Map<string, NativeMessage>();

  observe(
    sessionId: string,
    message: NativeMessage,
    branch?: readonly unknown[],
  ): void {
    if (sessionId !== this.sessionId) {
      this.reset();
      this.sessionId = sessionId;
    }
    if (branch) this.currentBranch = branch;
    if (this.steeredMessages.has(message) || isLogicalSteering(message)) {
      this.steeredMessages.add(message);
      return;
    }
    if (this.request?.message === message || this.final?.message === message)
      return;
    if (message.role === 'user') {
      this.previousRequest = this.request;
      this.previousFinal = this.final;
      this.previousWaiting = new Map(this.waiting);
      this.request = { message };
      this.final = undefined;
      this.marker = undefined;
      this.waiting.clear();
    } else if (message.role === 'assistant' && this.request) {
      this.final = { message };
    }
  }

  restore(ctx: ExtensionContext): void {
    this.reset();
    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch() as readonly unknown[];
    const steeredIds = steeringEntryIds(branch);
    const requests = branch.filter((entry) => {
      if (!isRecord(entry) || entry.type !== 'message') return false;
      const message = isRecord(entry.message) ? entry.message : undefined;
      return message?.role === 'user' && !steeredIds.has(String(entry.id));
    });
    const requestEntry = requests.at(-1);
    if (!isRecord(requestEntry) || !isRecord(requestEntry.message)) return;
    const requestMessageId = requestEntry.id;
    if (typeof requestMessageId !== 'string') return;
    const requestIndex = branch.indexOf(requestEntry);
    const closed = branch.some((entry) => {
      if (
        !isRecord(entry) ||
        entry.type !== 'custom' ||
        entry.customType !== RESPONSE_CLOSURE_MARKER_TYPE ||
        !isRecord(entry.data) ||
        entry.data.requestMessageId !== requestMessageId
      )
        return false;
      const marker = tryParseResponseClosure(entry.data);
      if (!marker) return false;
      const finalIndex = branch.findIndex(
        (candidate) =>
          isRecord(candidate) &&
          candidate.type === 'message' &&
          candidate.id === marker.finalMessageId &&
          isRecord(candidate.message) &&
          candidate.message.role === 'assistant',
      );
      return finalIndex > requestIndex;
    });
    if (closed) return;

    this.sessionId = sessionId;
    const restoredWaiting = new Map<string, Dependency>();
    let hadRegistration = false;
    let abandoned = false;
    let restoredFinal: TrackedMessage | undefined;
    for (const entry of branch.slice(requestIndex + 1)) {
      if (!isRecord(entry)) continue;
      if (entry.type === 'message' && isRecord(entry.message)) {
        if (entry.message.role === 'assistant')
          restoredFinal = { message: entry.message };
        continue;
      }
      if (
        entry.type !== 'custom' ||
        entry.customType !== REQUEST_DEPENDENCY_ENTRY_TYPE
      )
        continue;
      const record = dependencyRecord(entry.data);
      if (
        !record ||
        record.sessionId !== sessionId ||
        record.requestMessageId !== requestMessageId
      )
        continue;
      if (record.operation === 'abandon-request') {
        abandoned = true;
        continue;
      }
      const dependencyKey = key(record.kind, record.id);
      if (record.operation === 'register') {
        hadRegistration = true;
        restoredWaiting.set(dependencyKey, {
          kind: record.kind,
          id: record.id,
        });
      } else restoredWaiting.delete(dependencyKey);
    }
    if (!hadRegistration || abandoned) return;
    this.currentBranch = branch;
    this.request = { message: requestEntry.message };
    this.final = restoredFinal;
    this.waiting.clear();
    for (const [dependencyKey, dependency] of restoredWaiting)
      this.waiting.set(dependencyKey, dependency);
  }

  observeToolReceipt(
    sessionId: string,
    receiptId: string,
    toolName: string,
    result: unknown,
    parentToolCallId?: string,
  ): void {
    if (sessionId !== this.sessionId) return;
    if (
      toolName !== 'background_stop' &&
      toolName !== 'background_unwatch' &&
      toolName !== 'delegate_jobs'
    )
      return;
    const message = isRecord(result) ? result : undefined;
    if (!message || !isRecord(message.details)) return;
    this.controlReceipts.set(receiptId, {
      role: 'toolResult',
      toolCallId: receiptId,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      toolName,
      details: message.details,
    });
    if (this.controlReceipts.size > 128) {
      const oldest = this.controlReceipts.keys().next().value;
      if (oldest) this.controlReceipts.delete(oldest);
    }
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
    for (const [dependencyKey, dependency] of this.previousWaiting)
      this.waiting.set(dependencyKey, dependency);
    this.previousRequest = undefined;
    this.previousFinal = undefined;
    this.previousWaiting.clear();
  }

  registerDependency(
    kind: DependencyKind,
    id: string,
    ctx: RequestDependencyContext,
    appendEntry: (customType: string, data: unknown) => void,
  ): boolean {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId !== this.sessionId || !this.request || !id) return false;
    const branch = ctx.sessionManager.getBranch() as readonly unknown[];
    const steeredIds = steeringEntryIds(branch);
    const latestRequest = [...branch].reverse().find((entry) => {
      const message = messageFrom(entry);
      return (
        message?.role === 'user' &&
        !this.steeredMessages.has(message) &&
        !isLogicalSteering(message) &&
        !(isRecord(entry) && steeredIds.has(String(entry.id)))
      );
    });
    if (messageFrom(latestRequest) !== this.request.message) return false;
    const requestEntry = exactMessageEntry(branch, this.request.message);
    if (typeof requestEntry?.id !== 'string') return false;
    if (hasAmbiguousSteering(branch.slice(branch.indexOf(requestEntry) + 1)))
      return false;
    const dependencyKey = key(kind, id);
    if (this.waiting.has(dependencyKey)) return true;
    appendEntry(REQUEST_DEPENDENCY_ENTRY_TYPE, {
      version: 1,
      operation: 'register',
      sessionId,
      requestMessageId: requestEntry.id,
      kind,
      id,
    });
    this.waiting.set(dependencyKey, { kind, id });
    this.currentBranch = branch;
    this.marker = undefined;
    return true;
  }

  resolveDependency(
    kind: DependencyKind,
    id: string,
    appendEntry: (customType: string, data: unknown) => void,
  ): void {
    const branch = this.currentBranch;
    if (!branch) return;
    this.persistResolutions(
      [key(kind, id)],
      'source-registration-failed',
      branch,
      appendEntry,
    );
  }

  resolveDelegateGate(
    sources: readonly string[],
    mode: 'all' | 'any',
    appendEntry: (customType: string, data: unknown) => void,
  ): void {
    if (!this.request || this.waiting.size === 0) return;
    const selected = new Set(sources.map((id) => key('delegate', id)));
    if (![...selected].some((dependencyKey) => this.waiting.has(dependencyKey)))
      return;
    const resolved =
      mode === 'any'
        ? [...this.waiting.keys()].filter((dependencyKey) =>
            selected.has(dependencyKey),
          )
        : [...selected].filter((dependencyKey) =>
            this.waiting.has(dependencyKey),
          );
    if (this.currentBranch)
      this.persistResolutions(
        resolved,
        'delegate-gate',
        this.currentBranch,
        appendEntry,
      );
  }

  entered(
    messages: readonly unknown[],
    ctx: ExtensionContext,
    appendEntry: (customType: string, data: unknown) => void,
  ): void {
    const sessionId = ctx.sessionManager.getSessionId();
    if (
      sessionId !== this.sessionId ||
      !this.request ||
      this.waiting.size === 0
    )
      return;
    const enteredCalls = new Set<string>();
    for (const value of messages) {
      const message = messageFrom(value);
      if (message?.role !== 'toolResult') continue;
      if (typeof message.toolCallId === 'string')
        enteredCalls.add(message.toolCallId);
      const nested = isRecord(message.nestedCalls)
        ? message.nestedCalls.calls
        : undefined;
      if (Array.isArray(nested))
        for (const call of nested)
          if (isRecord(call) && typeof call.id === 'string')
            enteredCalls.add(call.id);
    }
    const receipts = [...this.controlReceipts.values()].filter(
      (receipt) =>
        typeof receipt.parentToolCallId === 'string' &&
        (enteredCalls.has(String(receipt.toolCallId)) ||
          enteredCalls.has(receipt.parentToolCallId)),
    );
    const branch = ctx.sessionManager.getBranch() as readonly unknown[];
    this.currentBranch = branch;
    const resolvedKeys = resultKeys([...messages, ...receipts]);
    const dependencies = [...this.waiting.keys()].filter((dependencyKey) =>
      resolvedKeys.has(dependencyKey),
    );
    this.persistResolutions(
      dependencies,
      'result-entered',
      branch,
      appendEntry,
    );
  }

  private persistResolutions(
    dependencyKeys: readonly string[],
    reason: string,
    branch: readonly unknown[],
    appendEntry: (customType: string, data: unknown) => void,
  ): void {
    if (!this.request) return;
    for (const dependencyKey of dependencyKeys) {
      const dependency = this.waiting.get(dependencyKey);
      if (!dependency) continue;
      const requestEntry = exactMessageEntry(branch, this.request.message);
      if (typeof requestEntry?.id !== 'string' || !this.sessionId) continue;
      appendEntry(REQUEST_DEPENDENCY_ENTRY_TYPE, {
        version: 1,
        operation: 'resolve',
        sessionId: this.sessionId,
        requestMessageId: requestEntry.id,
        kind: dependency.kind,
        id: dependency.id,
        reason,
      });
      this.waiting.delete(dependencyKey);
    }
  }

  private currentBranch?: readonly unknown[];

  abandon(
    ctx: ExtensionContext,
    appendEntry: (type: string, data: unknown) => void,
  ): void {
    if (ctx.sessionManager.getSessionId() !== this.sessionId || !this.request)
      return;
    const requestEntry = exactMessageEntry(
      ctx.sessionManager.getBranch(),
      this.request.message,
    );
    if (typeof requestEntry?.id !== 'string') return;
    appendEntry(REQUEST_DEPENDENCY_ENTRY_TYPE, {
      version: 1,
      operation: 'abandon-request',
      sessionId: this.sessionId,
      requestMessageId: requestEntry.id,
    });
    getScopedServices(this.sessionId).backgroundDeliveries.clear();
    this.reset();
  }

  beforeSettle(
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
    appendEntry: (customType: string, data: unknown) => void,
  ) {
    this.marker = undefined;
    this.currentBranch = ctx.sessionManager.getBranch() as readonly unknown[];
    if (event.outcome === 'aborted') {
      this.abandon(ctx, appendEntry);
      return;
    }
    const queuedResult = event.context.pendingMessages.some((message) => {
      if (message.role !== 'custom') return false;
      return (
        message.customType === 'background-terminal-result' ||
        message.customType === 'background-watch-result' ||
        message.customType === 'delegate-job-result' ||
        message.customType === 'delegate-wake-result'
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
    const branch = this.currentBranch;
    const requestEntry = exactMessageEntry(branch, request.message);
    const finalEntry = exactMessageEntry(branch, final.message);
    const startedAt =
      typeof requestEntry?.timestamp === 'string'
        ? Date.parse(requestEntry.timestamp)
        : Number.NaN;
    const endedAt =
      typeof finalEntry?.timestamp === 'string'
        ? Date.parse(finalEntry.timestamp)
        : Number.NaN;
    if (
      typeof requestEntry?.id !== 'string' ||
      typeof finalEntry?.id !== 'string' ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(endedAt)
    )
      return;
    this.marker = tryParseResponseClosure({
      requestMessageId: requestEntry.id,
      finalMessageId: finalEntry.id,
      startedAt,
      endedAt,
      ...(request.liveId ? { liveRequestMessageId: request.liveId } : {}),
      ...(final.liveId ? { liveFinalMessageId: final.liveId } : {}),
    });
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
    if (result && !this.waiting.size) {
      this.request = undefined;
      this.final = undefined;
      this.marker = undefined;
      this.previousRequest = undefined;
      this.previousFinal = undefined;
      this.previousWaiting.clear();
    }
    return result;
  }

  takeSettledMarker(ctx: ExtensionContext): ResponseClosureMarker | undefined {
    if (ctx.sessionManager.getSessionId() !== this.sessionId) return undefined;
    const marker = this.settledMarker;
    this.settledMarker = undefined;
    return marker;
  }

  isLogicallyOpen(sessionId: string): boolean {
    return sessionId === this.sessionId && !!this.request;
  }

  isOpen(ctx: ExtensionContext): boolean {
    return (
      ctx.sessionManager.getSessionId() === this.sessionId &&
      !!this.request &&
      !!exactMessageEntry(ctx.sessionManager.getBranch(), this.request.message)
    );
  }

  isRequired(kind: DependencyKind, id: string, ctx: ExtensionContext): boolean {
    return this.isOpen(ctx) && this.waiting.has(key(kind, id));
  }

  persistSteering(
    ctx: ExtensionContext,
    appendEntry: (type: string, data: unknown) => void,
  ): void {
    const branch = ctx.sessionManager.getBranch();
    const marked = steeringEntryIds(branch);
    for (const entry of branch) {
      if (
        entry.type !== 'message' ||
        entry.message.role !== 'user' ||
        marked.has(entry.id)
      )
        continue;
      if (
        this.steeredMessages.has(entry.message) ||
        isLogicalSteering(entry.message)
      )
        appendEntry(REQUEST_STEERING_ENTRY_TYPE, {
          userEntryId: entry.id,
          timestamp: entry.message.timestamp,
          text:
            typeof entry.message.content === 'string'
              ? entry.message.content
              : entry.message.content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join(''),
        });
    }
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
    this.previousRequest = undefined;
    this.previousFinal = undefined;
    this.previousWaiting.clear();
    this.controlReceipts.clear();
    this.currentBranch = undefined;
    this.steeredMessages = new WeakSet<object>();
  }
}

export function installRequestClosureBoundary(
  pi: ExtensionAPI,
  lifecycle: RequestClosureLifecycle,
): void {
  installLogicalInputShim();
  const bindDependencies = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const services = getScopedServices(sessionId);
    services.requestDependencies = {
      register: (kind, id, sourceCtx) =>
        lifecycle.registerDependency(kind, id, sourceCtx, (type, data) =>
          pi.appendEntry(type, data),
        ),
      resolve: (kind, id) =>
        lifecycle.resolveDependency(kind, id, (type, data) =>
          pi.appendEntry(type, data),
        ),
      resolveDelegateGate: (sources, mode) =>
        lifecycle.resolveDelegateGate(sources, mode, (type, data) =>
          pi.appendEntry(type, data),
        ),
      hasPending: () => lifecycle.hasPendingWait(ctx),
      isOpen: () => lifecycle.isOpen(ctx),
      isOpenNow: () => lifecycle.isLogicallyOpen(sessionId),
      abandon: () =>
        lifecycle.abandon(ctx, (type, data) => pi.appendEntry(type, data)),
      isRequired: (kind, id) => lifecycle.isRequired(kind, id, ctx),
    };
  };
  pi.on('message_end', (event, ctx) => {
    const message = messageFrom(event);
    if (!message) return;
    lifecycle.observe(
      ctx.sessionManager.getSessionId(),
      message,
      ctx.sessionManager.getBranch() as readonly unknown[],
    );
    bindDependencies(ctx);
  });
  pi.on('tool_execution_end', (event, ctx) =>
    lifecycle.observeToolReceipt(
      ctx.sessionManager.getSessionId(),
      event.toolCallId,
      event.toolName,
      event.result,
      event.parentToolCallId,
    ),
  );
  pi.on('context_with_system', (event, ctx) => {
    lifecycle.persistSteering(ctx, (type, data) => pi.appendEntry(type, data));
    lifecycle.entered(event.messages, ctx, (type, data) =>
      pi.appendEntry(type, data),
    );
  });
  pi.on('session_start', (_event, ctx) => {
    lifecycle.restore(ctx);
    bindDependencies(ctx);
  });
  pi.on('session_tree', (_event, ctx) => {
    getScopedServices(
      ctx.sessionManager.getSessionId(),
    ).backgroundDeliveries.clear();
    forgetLogicalInput(ctx.sessionManager.getSessionId());
    lifecycle.restore(ctx);
    bindDependencies(ctx);
  });
  pi.on('agent_before_settle', (event, ctx) =>
    lifecycle.beforeSettle(event, ctx, (type, data) =>
      pi.appendEntry(type, data),
    ),
  );
  pi.on('agent_settled', (_event, ctx) => {
    lifecycle.persistedMarker(ctx, (customType, data) =>
      pi.appendEntry(customType, data),
    );
    releaseLogicalFollowUps(ctx.sessionManager.getSessionId());
  });
  pi.on('session_shutdown', (_event, ctx) => {
    const services = getScopedServices(ctx.sessionManager.getSessionId());
    services.requestDependencies = undefined;
    forgetLogicalInput(ctx.sessionManager.getSessionId());
    lifecycle.reset();
  });
}
