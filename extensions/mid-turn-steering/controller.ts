import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import {
  type NativeSteeringController,
  type NativeSteeringResult,
  registerNativeSteeringController,
} from '../shared/runtime/native-steering';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_BUFFERED_EVENTS = 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const STEER_ACK_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;
type SocketEvent =
  | { type: 'open' }
  | { type: 'message'; message: unknown }
  | { type: 'error'; error: unknown }
  | { type: 'close'; code?: number; reason?: string };

export interface ResponsesSocket {
  send(event: JsonRecord): void;
  stream(): AsyncIterable<SocketEvent>;
  close(): void;
}

export type ResponsesSocketFactory = (
  apiKey: string,
  headers: Record<string, string>,
) => ResponsesSocket;

function createOpenAIResponsesSocket(
  apiKey: string,
  headers: Record<string, string>,
): ResponsesSocket {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.openai.com/v1',
    defaultHeaders: headers,
    maxRetries: 0,
  });
  const socket = new ResponsesWS(client, { reconnect: null });
  return {
    send(event) {
      socket.send(event as unknown as Parameters<typeof socket.send>[0]);
    },
    stream() {
      return socket.stream({
        maxBufferedEvents: MAX_BUFFERED_EVENTS,
      }) as AsyncIterable<SocketEvent>;
    },
    close() {
      socket.close();
    },
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eventResponseId(event: JsonRecord): string | undefined {
  const response = event.response;
  return isRecord(response) && typeof response.id === 'string'
    ? response.id
    : undefined;
}

function responseOutput(response: unknown): JsonRecord[] {
  if (!isRecord(response) || !Array.isArray(response.output)) return [];
  return response.output.filter(isRecord);
}

function toolCallIds(response: unknown): Set<string> {
  return new Set(
    responseOutput(response)
      .filter(
        (item) =>
          item.type === 'function_call' && typeof item.call_id === 'string',
      )
      .map((item) => item.call_id as string),
  );
}

function withoutInputAndStream(body: JsonRecord): JsonRecord {
  const settings = { ...body };
  delete settings.input;
  delete settings.stream;
  return settings;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function parseArguments(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return canonical(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function assistantText(item: JsonRecord): string | undefined {
  if (item.type !== 'message' || item.role !== 'assistant') return undefined;
  if (!Array.isArray(item.content)) return undefined;
  const text: string[] = [];
  for (const part of item.content) {
    if (!isRecord(part)) return undefined;
    if (part.type === 'output_text' && typeof part.text === 'string') {
      text.push(part.text);
    } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
      text.push(part.refusal);
    } else {
      return undefined;
    }
  }
  return text.join('');
}

function responseText(item: JsonRecord): string | undefined {
  if (item.type !== 'message' || !Array.isArray(item.content)) return undefined;
  const text: string[] = [];
  for (const part of item.content) {
    if (!isRecord(part)) return undefined;
    if (part.type === 'output_text' && typeof part.text === 'string') {
      text.push(part.text);
    } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
      text.push(part.refusal);
    }
  }
  return text.join('');
}

function sameFunctionCall(input: JsonRecord, output: JsonRecord): boolean {
  return (
    input.type === 'function_call' &&
    output.type === 'function_call' &&
    input.call_id === output.call_id &&
    input.name === output.name &&
    parseArguments(input.arguments) !== undefined &&
    parseArguments(input.arguments) === parseArguments(output.arguments)
  );
}

function wellFormedText(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index++;
      } else result += '\\ufffd';
    } else if (code >= 0xdc00 && code <= 0xdfff) result += '\\ufffd';
    else result += value[index];
  }
  return result;
}

function expectedUserText(input: JsonRecord, text: string): boolean {
  if (
    input.role !== 'user' ||
    (input.type !== undefined && input.type !== 'message')
  )
    return false;
  if (!Array.isArray(input.content) || input.content.length !== 1) return false;
  const [part] = input.content;
  return (
    isRecord(part) &&
    part.type === 'input_text' &&
    part.text === wellFormedText(text)
  );
}

class SseQueue {
  private readonly values: string[] = [];
  private readonly waiters: Array<{
    resolve(value: string | undefined): void;
    reject(error: Error): void;
  }> = [];
  private closed = false;
  private failure?: Error;
  private bytes = 0;

  push(event: JsonRecord): void {
    if (this.closed || this.failure)
      throw new Error('Responses stream is closed.');
    const value = `data: ${JSON.stringify(event)}\n\n`;
    const byteLength = Buffer.byteLength(value);
    if (
      this.values.length >= MAX_BUFFERED_EVENTS ||
      this.bytes + byteLength > MAX_BUFFERED_BYTES
    )
      throw new Error('Responses WebSocket event buffer exceeded its limit.');
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else {
      this.values.push(value);
      this.bytes += byteLength;
    }
  }

  close(): void {
    if (this.closed || this.failure) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined);
  }

  fail(error: Error): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<string | undefined> {
    const value = this.values.shift();
    if (value !== undefined) {
      this.bytes -= Buffer.byteLength(value);
      return Promise.resolve(value);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }

  get isClosed(): boolean {
    return this.closed || this.failure !== undefined;
  }
}

class ResponseSegment {
  readonly queue = new SseQueue();
  responseId?: string;
  response?: JsonRecord;
  terminalEvent?: JsonRecord;
  deferredTerminal?: JsonRecord;
  pendingRequiredInput?: unknown[];
  consumed = false;
  automatic = false;
  private terminalClosed = false;
  private readonly cleanups = new Set<() => void>();

  constructor(private readonly closeOnCancel: (reason: string) => void) {}

  addCleanup(cleanup: () => void): void {
    this.cleanups.add(cleanup);
  }

  push(event: JsonRecord): void {
    this.queue.push(event);
  }

  finish(event: JsonRecord): void {
    if (this.terminalClosed) return;
    this.queue.push(event);
    this.terminalClosed = true;
    this.queue.close();
    this.runCleanups();
  }

  deferTerminal(event: JsonRecord): void {
    this.deferredTerminal = event;
  }

  releaseTerminal(): void {
    const event = this.deferredTerminal;
    this.deferredTerminal = undefined;
    if (event) this.finish(event);
  }

  fail(error: Error): void {
    this.queue.fail(error);
    this.terminalClosed = true;
    this.runCleanups();
  }

  private runCleanups(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
  }

  responseBody(): Response {
    const encoder = new TextEncoder();
    const segment = this;
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const value = await segment.queue.next();
          if (value === undefined) stream.close();
          else stream.enqueue(encoder.encode(value));
        } catch (error) {
          stream.error(error);
        }
      },
      cancel() {
        if (!segment.queue.isClosed)
          segment.closeOnCancel('Responses stream consumer cancelled.');
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    });
  }
}

type AcceptedSteer = {
  id: string;
  input: string;
  responseId: string;
  admitted: boolean;
  status: 'accepted' | 'failed';
};

type PendingSteer = {
  responseId: string;
  input: string;
  resolve(
    result:
      | { status: 'accepted'; id: string }
      | { status: 'failed'; message: string }
      | { status: 'unknown'; message: string },
  ): void;
  result: Promise<
    | { status: 'accepted'; id: string }
    | { status: 'failed'; message: string }
    | { status: 'unknown'; message: string }
  >;
  settled: boolean;
  gateReleased: boolean;
  source?: ResponseSegment;
  accepted?: AcceptedSteer;
};

export class NativeResponsesController implements NativeSteeringController {
  private socket?: ResponsesSocket;
  private opened = false;
  private sentRequest = false;
  private closed = false;
  private failure?: Error;
  private initialSettings?: JsonRecord;
  private requestInput?: unknown[];
  private continuationStarting = false;
  private activeSegment?: ResponseSegment;
  private lastDeliveredSegment?: ResponseSegment;
  private automaticSegment?: ResponseSegment;
  private automaticWaiter?: {
    resolve(segment: ResponseSegment): void;
    reject(error: Error): void;
  };
  private expectedExplicitSegment?: ResponseSegment;
  private pendingSteer?: PendingSteer;
  private readonly segments = new Map<string, ResponseSegment>();
  private readonly acceptedByResponse = new Map<string, AcceptedSteer[]>();
  private readonly abortCleanup = new Map<AbortSignal, () => void>();
  private openResolve!: () => void;
  private openReject!: (error: Error) => void;
  private readonly openPromise: Promise<void>;

  constructor(
    readonly sessionId: string,
    private readonly apiKey: string,
    private readonly headers: Record<string, string>,
    private readonly isAgentActive: () => boolean,
    private readonly socketFactory: ResponsesSocketFactory = createOpenAIResponsesSocket,
  ) {
    this.openPromise = new Promise((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
    });
  }

  get hasSentRequest(): boolean {
    return this.sentRequest;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  canFallbackToHttp(body: JsonRecord): boolean {
    const source = this.lastDeliveredSegment;
    if (
      source?.terminalEvent?.type !== 'response.completed' ||
      this.pendingSteer
    )
      return false;
    const accepted = this.acceptedByResponse.get(source.responseId ?? '') ?? [];
    if (accepted.some((steer) => steer.status === 'accepted' || steer.admitted))
      return false;
    try {
      this.validateContinuationSettings(body);
      this.continuationInput(body, source);
      return false;
    } catch {
      return true;
    }
  }

  canStartNextRequest(): boolean {
    const segment = this.lastDeliveredSegment;
    return (
      !this.closed &&
      !this.continuationStarting &&
      segment?.queue.isClosed === true &&
      segment.terminalEvent !== undefined &&
      !segment.consumed
    );
  }

  isAvailable(): boolean {
    const segment = this.activeSegment;
    return (
      !this.closed &&
      this.opened &&
      this.isAgentActive() &&
      typeof this.latestResponseId() === 'string' &&
      this.pendingSteer === undefined &&
      (segment === undefined ||
        !(this.acceptedByResponse.get(segment.responseId ?? '') ?? []).some(
          (steer) => steer.status === 'accepted',
        ))
    );
  }

  async startInitial(
    body: JsonRecord,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (this.socket || this.closed)
      throw new Error('Native Responses session already started.');
    if (!Array.isArray(body.input))
      throw new Error(
        'Native steering requires Responses input to be an array.',
      );
    this.initialSettings = withoutInputAndStream(body);
    this.requestInput = structuredClone(body.input);
    const segment = new ResponseSegment((reason) => this.close(reason));
    this.activeSegment = segment;
    this.lastDeliveredSegment = segment;
    segment.addCleanup(this.attachAbortSignal(signal));
    if (this.closed)
      throw this.failure ?? new Error('Native Responses request aborted.');
    this.socket = this.socketFactory(this.apiKey, this.headers);
    void this.pump(this.socket);
    try {
      await this.openPromise;
    } catch (error) {
      this.fail(asError(error));
      throw asError(error);
    }
    const create = this.createEvent(body);
    this.sentRequest = true;
    this.socket.send(create);
    return segment.responseBody();
  }

  async startNext(body: JsonRecord, signal?: AbortSignal): Promise<Response> {
    if (!this.canStartNextRequest())
      throw (
        this.failure ?? new Error('Native Responses continuation is not ready.')
      );
    this.continuationStarting = true;
    let releaseAbort = this.attachAbortSignal(signal);
    try {
      this.validateContinuationSettings(body);
      const source = this.lastDeliveredSegment;
      if (!source?.responseId)
        throw new Error(
          'Native Responses continuation has no previous response.',
        );
      const socket = this.socket;
      if (!socket)
        throw new Error('Native Responses connection is unavailable.');
      const delta = this.continuationInput(body, source);
      let segment: ResponseSegment;
      const callIds = toolCallIds(source.response);
      const hasRequiredTools = callIds.size > 0;
      const accepted = this.acceptedByResponse.get(source.responseId) ?? [];
      if (accepted.some((steer) => !steer.admitted))
        throw new Error('Native steering admission has not completed.');
      const activeAccepted = accepted.filter(
        (steer) => steer.status === 'accepted',
      );

      if (activeAccepted.length > 0 && !hasRequiredTools) {
        if (delta.length !== 0)
          throw new Error('Unexpected input beside the accepted native steer.');
        segment = await this.takeAutomaticSegment();
        segment.automatic = true;
      } else {
        segment = new ResponseSegment((reason) => this.close(reason));
        this.activeSegment = segment;
        this.expectedExplicitSegment = segment;
        const create = this.createEvent({
          ...body,
          input: delta,
          previous_response_id: source.responseId,
        });
        this.sentRequest = true;
        socket.send(create);
      }

      segment.addCleanup(releaseAbort);
      releaseAbort = () => undefined;
      source.consumed = true;
      this.requestInput = structuredClone(body.input as unknown[]);
      this.lastDeliveredSegment = segment;
      this.pruneTrackedResponses();
      return segment.responseBody();
    } catch (error) {
      releaseAbort();
      const failure = asError(error);
      this.fail(failure);
      throw failure;
    } finally {
      this.continuationStarting = false;
    }
  }

  async steer(
    input: string,
    onAccepted: () => void | Promise<void>,
  ): Promise<NativeSteeringResult> {
    const responseId = this.latestResponseId();
    if (!this.isAvailable() || !responseId || !this.socket) {
      return { status: 'failed', message: 'Native steering is not available.' };
    }
    if (!input.trim())
      return { status: 'failed', message: 'Steering input must not be empty.' };

    let resolve!: PendingSteer['resolve'];
    const result = new Promise<Parameters<PendingSteer['resolve']>[0]>(
      (accept) => (resolve = accept),
    );
    const pending: PendingSteer = {
      responseId,
      input,
      resolve,
      result,
      settled: false,
      gateReleased: false,
      source: this.segments.get(responseId),
    };
    this.pendingSteer = pending;
    try {
      this.socket.send({
        type: 'response.steer',
        previous_response_id: responseId,
        input,
      });
    } catch (error) {
      const message = `Steering send outcome is unknown: ${asError(error).message}`;
      this.resolvePending({ status: 'unknown', message });
      this.fail(new Error(message));
    }

    const timeout = setTimeout(() => {
      const message = 'Native steering acknowledgment timed out.';
      this.resolvePending({ status: 'unknown', message });
      this.fail(new Error(message));
    }, STEER_ACK_TIMEOUT_MS);
    let ack: Awaited<typeof result>;
    try {
      ack = await result;
    } finally {
      clearTimeout(timeout);
    }
    if (ack.status === 'failed') {
      pending.gateReleased = true;
      pending.source?.releaseTerminal();
      if (this.pendingSteer === pending) this.pendingSteer = undefined;
      return ack;
    }
    if (ack.status === 'unknown') return ack;

    try {
      await onAccepted();
    } catch (error) {
      const message = `OpenAI accepted steering, but native message admission failed: ${asError(error).message}`;
      pending.gateReleased = true;
      pending.source?.fail(new Error(message));
      this.fail(new Error(message));
      return { status: 'unknown', message };
    }

    if (this.closed) {
      return {
        status: 'unknown',
        message: 'Native steering closed before admission completed.',
      };
    }
    if (!pending.accepted) {
      const message = 'Steering acceptance was lost before native admission.';
      this.fail(new Error(message));
      return { status: 'unknown', message };
    }
    pending.accepted.admitted = true;
    pending.gateReleased = true;
    pending.source?.releaseTerminal();
    if (this.pendingSteer === pending) this.pendingSteer = undefined;
    return { status: 'accepted', steerId: ack.id };
  }

  close(reason = 'Native Responses session closed.'): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(reason);
    if (!this.opened) this.openReject(error);
    const automaticWaiter = this.automaticWaiter;
    this.automaticWaiter = undefined;
    automaticWaiter?.reject(error);
    if (this.pendingSteer && !this.pendingSteer.settled) {
      this.resolvePending({ status: 'unknown', message: reason });
    }
    this.clearTrackedState(error);
    for (const cleanup of [...this.abortCleanup.values()]) cleanup();
    this.abortCleanup.clear();
    try {
      this.socket?.close();
    } catch {
      // Closing an already closed socket is harmless.
    }
  }

  private latestResponseId(): string | undefined {
    return (
      this.activeSegment?.responseId ?? this.lastDeliveredSegment?.responseId
    );
  }

  private attachAbortSignal(signal?: AbortSignal): () => void {
    if (!signal) return () => undefined;
    if (signal.aborted) {
      this.close('Native Responses request aborted.');
      return () => undefined;
    }
    const existing = this.abortCleanup.get(signal);
    if (existing) return existing;
    const abort = () => this.close('Native Responses request aborted.');
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      this.abortCleanup.delete(signal);
    };
    this.abortCleanup.set(signal, cleanup);
    return cleanup;
  }

  private createEvent(body: JsonRecord): JsonRecord {
    const { stream: _stream, ...params } = body;
    return { type: 'response.create', ...params };
  }

  private validateContinuationSettings(body: JsonRecord): void {
    if (
      !Array.isArray(body.input) ||
      !this.initialSettings ||
      !this.requestInput
    )
      throw new Error(
        'Native Responses continuation has no valid request history.',
      );
    if (!isDeepStrictEqual(withoutInputAndStream(body), this.initialSettings))
      throw new Error('Native Responses continuation settings changed.');
    if (body.input.length < this.requestInput.length)
      throw new Error('Native Responses continuation history was truncated.');
    if (
      !isDeepStrictEqual(
        body.input.slice(0, this.requestInput.length),
        this.requestInput,
      )
    )
      throw new Error('Native Responses continuation history does not match.');
  }

  private continuationInput(
    body: JsonRecord,
    source: ResponseSegment,
  ): unknown[] {
    const requestInput = this.requestInput;
    if (!requestInput || !source.responseId)
      throw new Error(
        'Native Responses continuation has no valid request history.',
      );
    const suffix = (body.input as unknown[]).slice(requestInput.length);
    const output = responseOutput(source.response);
    const unmatchedOutput = new Set(output.map((_, index) => index));
    const accepted = this.acceptedByResponse.get(source.responseId) ?? [];
    const acceptedCounts = accepted.map(() => 0);
    const callIds = toolCallIds(source.response);
    const pendingInput = source.response?.id
      ? this.requiredToolCallIds(source)
      : new Set<string>();
    const requiredCallIds = pendingInput.size > 0 ? pendingInput : callIds;
    const returnedCallIds = new Map<string, number>();
    const delta: unknown[] = [];

    for (const rawItem of suffix) {
      if (!isRecord(rawItem))
        throw new Error(
          'Native Responses continuation contains an invalid item.',
        );
      if (rawItem.type === 'function_call_output') {
        if (
          typeof rawItem.call_id !== 'string' ||
          !callIds.has(rawItem.call_id)
        )
          throw new Error(
            'Native Responses continuation contains an unexpected tool result.',
          );
        returnedCallIds.set(
          rawItem.call_id,
          (returnedCallIds.get(rawItem.call_id) ?? 0) + 1,
        );
        delta.push(rawItem);
        continue;
      }
      if (
        rawItem.role === 'user' &&
        (rawItem.type === undefined || rawItem.type === 'message')
      ) {
        const acceptedIndex = accepted.findIndex(
          (entry, index) =>
            entry.status === 'accepted' &&
            acceptedCounts[index] === 0 &&
            expectedUserText(rawItem, entry.input),
        );
        if (acceptedIndex >= 0) acceptedCounts[acceptedIndex]++;
        else {
          const failedIndex = accepted.findIndex(
            (entry, index) =>
              entry.status === 'failed' &&
              acceptedCounts[index] === 0 &&
              expectedUserText(rawItem, entry.input),
          );
          if (failedIndex >= 0) acceptedCounts[failedIndex]++;
          delta.push(rawItem);
        }
        continue;
      }
      if (rawItem.type === 'message' && rawItem.role === 'assistant') {
        const text = assistantText(rawItem);
        const match = output.findIndex(
          (item, index) =>
            unmatchedOutput.has(index) &&
            item.type === 'message' &&
            responseText(item) === text,
        );
        if (text === undefined || match < 0)
          throw new Error(
            'Native Responses continuation assistant history changed.',
          );
        unmatchedOutput.delete(match);
        continue;
      }
      if (rawItem.type === 'function_call') {
        const match = output.findIndex(
          (item, index) =>
            unmatchedOutput.has(index) && sameFunctionCall(rawItem, item),
        );
        if (match < 0)
          throw new Error(
            'Native Responses continuation tool-call history changed.',
          );
        unmatchedOutput.delete(match);
        continue;
      }
      if (rawItem.type === 'reasoning') {
        const match = output.findIndex(
          (item, index) =>
            unmatchedOutput.has(index) &&
            item.type === 'reasoning' &&
            isDeepStrictEqual(rawItem, item),
        );
        if (match < 0)
          throw new Error(
            'Native Responses continuation reasoning history changed.',
          );
        unmatchedOutput.delete(match);
        continue;
      }
      throw new Error(
        'Native Responses continuation contains unsupported history.',
      );
    }

    if (acceptedCounts.some((count) => count !== 1))
      throw new Error('Steering input is missing or duplicated in Pi history.');
    for (const callId of requiredCallIds) {
      if (returnedCallIds.get(callId) !== 1)
        throw new Error(
          'A required client tool result is missing or duplicated.',
        );
    }
    for (const count of returnedCallIds.values()) {
      if (count !== 1) throw new Error('A client tool result is duplicated.');
    }
    if (unmatchedOutput.size > 0)
      throw new Error(
        'Native Responses continuation is missing assistant history.',
      );
    return delta;
  }

  private pruneTrackedResponses(): void {
    const retained = new Set(
      [
        this.activeSegment,
        this.lastDeliveredSegment,
        this.automaticSegment,
        this.expectedExplicitSegment,
        this.pendingSteer?.source,
      ].filter((segment): segment is ResponseSegment => segment !== undefined),
    );
    const retainedIds = new Set(
      [...retained]
        .map((segment) => segment.responseId)
        .filter((id): id is string => id !== undefined),
    );
    for (const [id, segment] of this.segments) {
      if (!retained.has(segment)) this.segments.delete(id);
    }
    for (const id of this.acceptedByResponse.keys()) {
      if (!retainedIds.has(id)) this.acceptedByResponse.delete(id);
    }
  }

  private requiredToolCallIds(source: ResponseSegment): Set<string> {
    const pending = source.pendingRequiredInput;
    if (!pending) return new Set();
    const callIds = new Set<string>();
    for (const item of pending) {
      if (
        !isRecord(item) ||
        item.type !== 'function_call_output' ||
        typeof item.call_id !== 'string'
      ) {
        throw new Error(
          'Native Responses continuation requires unsupported approval input.',
        );
      }
      callIds.add(item.call_id);
    }
    return callIds;
  }

  private async takeAutomaticSegment(): Promise<ResponseSegment> {
    if (this.automaticSegment) {
      const segment = this.automaticSegment;
      this.automaticSegment = undefined;
      this.pruneTrackedResponses();
      return segment;
    }
    return new Promise((resolve, reject) => {
      this.automaticWaiter = { resolve, reject };
      if (this.closed)
        reject(this.failure ?? new Error('Native Responses socket closed.'));
    });
  }

  private async pump(socket: ResponsesSocket): Promise<void> {
    try {
      for await (const record of socket.stream()) {
        if (this.closed) return;
        if (record.type === 'open') {
          this.opened = true;
          this.openResolve();
          continue;
        }
        if (record.type === 'error') {
          throw asError(record.error);
        }
        if (record.type === 'close') {
          throw new Error(
            `Responses WebSocket closed${record.code ? ` (${record.code})` : ''}${record.reason ? `: ${record.reason}` : ''}.`,
          );
        }
        if (record.type !== 'message' || !isRecord(record.message)) continue;
        this.handleMessage(record.message);
      }
      if (!this.closed)
        throw new Error('Responses WebSocket ended unexpectedly.');
    } catch (error) {
      const failure = asError(error);
      if (!this.opened) this.openReject(failure);
      this.fail(failure);
    }
  }

  private handleMessage(event: JsonRecord): void {
    const type = event.type;
    if (typeof type !== 'string') return;

    if (type === 'response.steer.accepted') {
      const steer = isRecord(event.steer) ? event.steer : undefined;
      const id = steer?.id;
      const responseId = steer?.previous_response_id;
      const pending = this.pendingSteer;
      if (
        !pending ||
        pending.settled ||
        typeof id !== 'string' ||
        responseId !== pending.responseId
      ) {
        this.fail(new Error('Received an unmatched steering acceptance.'));
        return;
      }
      const accepted: AcceptedSteer = {
        id,
        input: pending.input,
        responseId: pending.responseId,
        admitted: false,
        status: 'accepted',
      };
      pending.accepted = accepted;
      const list = this.acceptedByResponse.get(responseId) ?? [];
      list.push(accepted);
      this.acceptedByResponse.set(responseId, list);
      pending.source = this.segments.get(responseId);
      pending.settled = true;
      pending.resolve({ status: 'accepted', id });
      return;
    }

    if (type === 'response.steer.failed') {
      const steer = isRecord(event.steer) ? event.steer : undefined;
      const pending = this.pendingSteer;
      const responseId = steer?.previous_response_id;
      const error = isRecord(event.error) ? event.error : undefined;
      const message =
        typeof error?.message === 'string'
          ? error.message
          : 'OpenAI rejected the steering input.';
      if (pending && !pending.settled && responseId === pending.responseId) {
        pending.settled = true;
        pending.resolve({ status: 'failed', message });
        return;
      }
      const steerId = steer?.id;
      const accepted =
        typeof responseId === 'string' && typeof steerId === 'string'
          ? this.acceptedByResponse
              .get(responseId)
              ?.find((item) => item.id === steerId)
          : undefined;
      if (accepted?.status !== 'accepted') {
        this.fail(new Error('Received an unmatched steering failure.'));
        return;
      }
      accepted.status = 'failed';
      return;
    }

    if (type === 'response.steer.pending') {
      const steer = isRecord(event.steer) ? event.steer : undefined;
      const responseId = steer?.previous_response_id;
      const source =
        typeof responseId === 'string'
          ? this.segments.get(responseId)
          : undefined;
      if (
        typeof responseId !== 'string' ||
        !source ||
        !Array.isArray(event.required_input)
      ) {
        this.fail(new Error('Received invalid pending steering requirements.'));
        return;
      }
      source.pendingRequiredInput = event.required_input;
      return;
    }

    if (type === 'response.created') {
      this.handleResponseCreated(event);
      return;
    }

    const active = this.activeSegment;
    if (!active) {
      this.fail(
        new Error('Received a Responses event without an active request.'),
      );
      return;
    }
    if (active.terminalEvent) {
      this.fail(new Error('Received response data after its terminal event.'));
      return;
    }
    if (
      type === 'response.completed' ||
      type === 'response.incomplete' ||
      type === 'response.failed'
    ) {
      this.finishResponse(active, event);
    } else {
      active.push(event);
      if (type === 'error')
        this.fail(new Error('OpenAI returned a Responses WebSocket error.'));
    }
  }

  private handleResponseCreated(event: JsonRecord): void {
    const responseId = eventResponseId(event);
    if (!responseId) {
      this.fail(new Error('Responses created event has no response ID.'));
      return;
    }
    if (this.expectedExplicitSegment) {
      const segment = this.expectedExplicitSegment;
      this.expectedExplicitSegment = undefined;
      segment.responseId = responseId;
      this.activeSegment = segment;
      this.segments.set(responseId, segment);
      segment.push(event);
      this.pruneTrackedResponses();
      return;
    }
    if (!this.activeSegment?.responseId) {
      const segment = this.activeSegment;
      if (!segment) {
        this.fail(new Error('Responses created event has no request owner.'));
        return;
      }
      segment.responseId = responseId;
      this.segments.set(responseId, segment);
      segment.push(event);
      this.pruneTrackedResponses();
      return;
    }
    const previous = this.activeSegment;
    const previousResponseId = previous.responseId;
    if (!previousResponseId) {
      this.fail(new Error('Previous Responses segment has no response ID.'));
      return;
    }
    const accepted = (
      this.acceptedByResponse.get(previousResponseId) ?? []
    ).filter((steer) => steer.status === 'accepted');
    if (
      !previous.terminalEvent ||
      accepted.length === 0 ||
      toolCallIds(previous.response).size > 0 ||
      this.automaticSegment !== undefined
    ) {
      this.fail(
        new Error('Received an unexpected automatic Responses successor.'),
      );
      return;
    }
    const segment = new ResponseSegment((reason) => this.close(reason));
    segment.automatic = true;
    segment.responseId = responseId;
    this.activeSegment = segment;
    this.segments.set(responseId, segment);
    this.automaticSegment = segment;
    const waiter = this.automaticWaiter;
    this.automaticWaiter = undefined;
    if (waiter) {
      this.automaticSegment = undefined;
      waiter.resolve(segment);
    }
    segment.push(event);
    this.pruneTrackedResponses();
  }

  private finishResponse(segment: ResponseSegment, event: JsonRecord): void {
    segment.terminalEvent = event;
    segment.response = isRecord(event.response) ? event.response : undefined;
    const responseId = eventResponseId(event);
    if (responseId) {
      segment.responseId = responseId;
      this.segments.set(responseId, segment);
    }
    const pending = this.pendingSteer;
    if (
      pending &&
      pending.responseId === segment.responseId &&
      !pending.gateReleased
    ) {
      pending.source = segment;
      segment.deferTerminal(event);
    } else {
      segment.finish(event);
    }
  }

  private resolvePending(
    result:
      | { status: 'accepted'; id: string }
      | { status: 'failed'; message: string }
      | { status: 'unknown'; message: string },
  ): void {
    const pending = this.pendingSteer;
    if (!pending || pending.settled) return;
    pending.settled = true;
    pending.resolve(result);
  }

  private clearTrackedState(error: Error): void {
    const segments = new Set([
      this.activeSegment,
      this.lastDeliveredSegment,
      this.automaticSegment,
      this.expectedExplicitSegment,
      this.pendingSteer?.source,
    ]);
    for (const segment of segments) segment?.fail(error);
    this.activeSegment = undefined;
    this.lastDeliveredSegment = undefined;
    this.automaticSegment = undefined;
    this.expectedExplicitSegment = undefined;
    this.pendingSteer = undefined;
    this.initialSettings = undefined;
    this.requestInput = undefined;
    this.segments.clear();
    this.acceptedByResponse.clear();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    const automaticWaiter = this.automaticWaiter;
    this.automaticWaiter = undefined;
    automaticWaiter?.reject(error);
    if (!this.opened) this.openReject(error);
    this.resolvePending({ status: 'unknown', message: error.message });
    this.clearTrackedState(error);
    for (const cleanup of [...this.abortCleanup.values()]) cleanup();
    this.abortCleanup.clear();
    try {
      this.socket?.close();
    } catch {
      // The socket may already be closed.
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createNativeResponsesController(
  sessionId: string,
  apiKey: string,
  headers: Record<string, string>,
  isAgentActive: () => boolean,
  socketFactory?: ResponsesSocketFactory,
): NativeResponsesController {
  const controller = new NativeResponsesController(
    sessionId,
    apiKey,
    headers,
    isAgentActive,
    socketFactory,
  );
  registerNativeSteeringController(sessionId, controller);
  return controller;
}
