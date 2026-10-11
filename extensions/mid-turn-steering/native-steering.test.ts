import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai/compat';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllNativeSteeringControllers,
  getNativeSteeringController,
  setNativeSteeringAgentActive,
} from '../shared/runtime/native-steering';
import type { ResponsesSocket, ResponsesSocketFactory } from './controller';
import { createNativeSteeringStream, isNativeSteeringEligible } from './index';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type QueueItem<T> = IteratorResult<T>;

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private values: T[] = [];
  private waiters: Array<(result: QueueItem<T>) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  next(): Promise<QueueItem<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<QueueItem<T>> {
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

class FakeSocket implements ResponsesSocket {
  readonly incoming = new AsyncQueue<
    | { type: 'open' }
    | { type: 'message'; message: unknown }
    | { type: 'close'; code?: number; reason?: string }
    | { type: 'error'; error: unknown }
  >();
  readonly sent = new AsyncQueue<JsonRecord>();
  readonly sentEvents: JsonRecord[] = [];
  closeCount = 0;

  constructor() {
    this.incoming.push({ type: 'open' });
  }

  send(event: JsonRecord): void {
    this.sentEvents.push(event);
    this.sent.push(event);
  }

  stream(): AsyncIterable<
    | { type: 'open' }
    | { type: 'message'; message: unknown }
    | { type: 'close'; code?: number; reason?: string }
    | { type: 'error'; error: unknown }
  > {
    return this.incoming;
  }

  emit(message: JsonRecord): void {
    this.incoming.push({ type: 'message', message });
  }

  disconnect(): void {
    this.incoming.push({
      type: 'close',
      code: 1006,
      reason: 'test disconnect',
    });
  }

  close(): void {
    this.closeCount++;
    this.incoming.push({ type: 'close', code: 1000, reason: 'closed' });
  }

  nextSent(): Promise<JsonRecord> {
    return this.sent.next().then((result) => {
      if (result.done) throw new Error('Fake socket send queue closed.');
      return result.value;
    });
  }
}

const MODEL: Model<'openai-responses'> = {
  id: 'gpt-6-astra',
  name: 'GPT-6 Astra',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

const FULL_USAGE = {
  input_tokens: 10,
  output_tokens: 4,
  total_tokens: 14,
  input_tokens_details: { cached_tokens: 2 },
  output_tokens_details: { reasoning_tokens: 1 },
};

function makeSocketFactory(): {
  factory: ResponsesSocketFactory;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  const factory: ResponsesSocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

function baseContext(text = 'original prompt'): TranscriptContext {
  return {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: 1,
      },
    ],
  } as TranscriptContext;
}

function addAssistantAndUser(
  context: TranscriptContext,
  assistant: AssistantMessage,
  text: string,
): TranscriptContext {
  return {
    messages: [
      ...context.messages,
      assistant,
      {
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: 2,
      },
    ],
  } as TranscriptContext;
}

function textOutput(responseId: string, text: string): JsonRecord {
  return {
    id: `msg_${responseId}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function textEvents(
  responseId: string,
  text: string,
  usage: unknown = FULL_USAGE,
  status: 'completed' | 'incomplete' = 'completed',
): JsonRecord[] {
  const message = textOutput(responseId, text);
  const events: JsonRecord[] = [
    {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: message.id,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
  ];
  if (text) {
    events.push({
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
  }
  events.push(
    {
      type: 'response.output_text.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.content_part.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: message,
    },
    {
      type:
        status === 'completed' ? 'response.completed' : 'response.incomplete',
      response: {
        id: responseId,
        status,
        ...(status === 'incomplete'
          ? { incomplete_details: { reason: 'steered' } }
          : {}),
        output: [message],
        ...(usage === undefined ? {} : { usage }),
      },
    },
  );
  return events;
}

function emptyEvents(responseId: string, usage?: unknown): JsonRecord[] {
  return [
    {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress', output: [] },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [],
        ...(usage === undefined ? {} : { usage }),
      },
    },
  ];
}

function toolEvents(responseId: string): JsonRecord[] {
  const call = {
    id: 'fc_test_1',
    call_id: 'call_test_1',
    type: 'function_call',
    name: 'lookup',
    arguments: '{"key":"value"}',
    status: 'completed',
  };
  return [
    {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...call, arguments: '', status: 'in_progress' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: call.id,
      output_index: 0,
      delta: '{"key":"value"}',
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: call.id,
      output_index: 0,
      arguments: '{"key":"value"}',
    },
    { type: 'response.output_item.done', output_index: 0, item: call },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [call],
        usage: FULL_USAGE,
      },
    },
  ];
}

function reasonedSteeredEvents(responseId: string, text: string): JsonRecord[] {
  const reasoning = {
    id: `rs_${responseId}`,
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'short internal reasoning' }],
    encrypted_content: 'native-reasoning-signature',
  };
  const messageEvents = textEvents(responseId, text, FULL_USAGE, 'incomplete');
  const terminal = messageEvents.at(-1);
  if (!terminal || !isRecord(terminal.response))
    throw new Error('Expected an incomplete response event.');
  const response = terminal.response;
  if (!Array.isArray(response.output) || !isRecord(response.output[0]))
    throw new Error('Expected an assistant output item.');
  const message = response.output[0];
  const created = messageEvents[0];
  if (!created) throw new Error('Expected a response-created event.');
  message.phase = 'final_answer';
  response.output = [reasoning, message];
  const messageFlow = messageEvents.slice(1, -1).map((event) => {
    const indexed: JsonRecord = { ...event, output_index: 1 };
    if (isRecord(event.item))
      indexed.item = {
        ...event.item,
        ...(event.type === 'response.output_item.added'
          ? { phase: 'final_answer' }
          : {}),
      };
    return indexed;
  });
  return [
    created,
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: reasoning.id,
        type: 'reasoning',
        summary: [],
        encrypted_content: null,
      },
    },
    {
      type: 'response.reasoning_summary_part.added',
      item_id: reasoning.id,
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: reasoning.id,
      output_index: 0,
      summary_index: 0,
      delta: 'short internal reasoning',
    },
    {
      type: 'response.reasoning_summary_text.done',
      item_id: reasoning.id,
      output_index: 0,
      summary_index: 0,
      text: 'short internal reasoning',
    },
    {
      type: 'response.reasoning_summary_part.done',
      item_id: reasoning.id,
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: 'short internal reasoning' },
    },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    ...messageFlow,
    terminal,
  ];
}

function collect(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  return (async () => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  })();
}

async function waitForSocket(sockets: FakeSocket[]): Promise<FakeSocket> {
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  if (!socket) throw new Error('Expected a WebSocket.');
  return socket;
}

async function emitAll(
  socket: FakeSocket,
  events: JsonRecord[],
): Promise<void> {
  for (const event of events) socket.emit(event);
}

const SESSION_ID = 'native-test-session';
const OPTIONS = {
  apiKey: 'sk-test-key-not-used-for-network',
  sessionId: SESSION_ID,
} satisfies SimpleStreamOptions;

function activateSession(): void {
  setNativeSteeringAgentActive(SESSION_ID, true);
}

function requireController(sessionId = SESSION_ID) {
  const controller = getNativeSteeringController(sessionId);
  if (!controller)
    throw new Error(`Expected a steering controller for ${sessionId}.`);
  return controller;
}

afterEach(() => {
  vi.useRealTimers();
  clearAllNativeSteeringControllers('test cleanup');
});

describe('native mid-turn steering transport', () => {
  it('sends the built-in request payload and parses synthetic SSE with normal usage and hooks', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    let builtPayload: unknown;
    const rawEvents: unknown[] = [];
    const context = baseContext();
    const stream = provider(MODEL, context, {
      ...OPTIONS,
      onPayload(payload) {
        builtPayload = { ...(payload as JsonRecord), temperature: 0.3 };
        return builtPayload;
      },
      onProviderStreamEvent(event) {
        rawEvents.push(event);
      },
    });
    const eventsPromise = collect(stream);
    const socket = await waitForSocket(sockets);
    const request = await socket.nextSent();
    const expected = JSON.parse(JSON.stringify(builtPayload)) as JsonRecord;
    delete expected.stream;
    expect(request).toEqual({ type: 'response.create', ...expected });
    expect(request.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'original prompt' }],
      },
    ]);

    const responseEvents = textEvents('resp_normal', 'hello from SSE');
    await emitAll(socket, responseEvents);
    const events = await eventsPromise;
    const done = events.find((event) => event.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type !== 'done')
      throw new Error('Expected a successful completion.');
    expect(done.message.content).toEqual([
      {
        type: 'text',
        text: 'hello from SSE',
        textSignature: expect.any(String),
      },
    ]);
    expect(done.message.usage).toMatchObject({
      input: 8,
      output: 4,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 14,
      cost: {
        input: 0.000008,
        output: 0.000008,
        cacheRead: 0.000001,
        cacheWrite: 0,
        total: 0.000017,
      },
    });
    expect(rawEvents).toContainEqual(responseEvents.at(-1));
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(1);
  });

  it('preserves final upstream affinity and custom headers in the socket handshake', async () => {
    activateSession();
    const socket = new FakeSocket();
    let socketHeaders: Record<string, string> | undefined;
    const provider = createNativeSteeringStream((_apiKey, headers) => {
      socketHeaders = headers;
      return socket;
    });
    const result = collect(
      provider(
        { ...MODEL, headers: { 'OpenAI-Organization': 'org-fixture' } },
        baseContext(),
        {
          ...OPTIONS,
          headers: {
            'OpenAI-Project': 'project-fixture',
            'x-custom-test': 'fixture',
          },
        },
      ),
    );
    await socket.nextSent();
    await emitAll(socket, emptyEvents('resp_headers'));
    expect((await result).some((event) => event.type === 'done')).toBe(true);
    expect(socketHeaders).toMatchObject({
      session_id: SESSION_ID,
      'x-client-request-id': SESSION_ID,
      'openai-organization': 'org-fixture',
      'openai-project': 'project-fixture',
      'x-custom-test': 'fixture',
    });
    expect(socketHeaders).not.toHaveProperty('content-type');
    expect(socketHeaders).not.toHaveProperty('content-length');
  });

  it('falls back before any create when socket construction fails without an orphaned rejection', async () => {
    activateSession();
    const factory = vi.fn(() => {
      throw new Error('WebSocket runtime is unavailable.');
    });
    const fallback = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          emptyEvents('resp_setup_fallback')
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const events = await collect(
      createNativeSteeringStream(factory, fallback)(MODEL, baseContext(), {
        ...OPTIONS,
        maxRetries: 0,
      }),
    );
    expect(events.some((event) => event.type === 'done')).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(getNativeSteeringController(SESSION_ID)).toBeUndefined();
  });

  it('pins an uncertain create write so a retry cannot create or fall back again', async () => {
    activateSession();
    const socket = new FakeSocket();
    socket.send = (event) => {
      socket.sentEvents.push(event);
      throw new Error('Write outcome is unknown.');
    };
    const fallback = vi.fn<typeof globalThis.fetch>();
    const provider = createNativeSteeringStream(() => socket, fallback);
    const options = { ...OPTIONS, maxRetries: 0 };
    const first = await collect(provider(MODEL, baseContext(), options));
    expect(first.some((event) => event.type === 'error')).toBe(true);
    const retry = await collect(provider(MODEL, baseContext(), options));
    expect(retry.some((event) => event.type === 'error')).toBe(true);
    expect(socket.sentEvents).toHaveLength(1);
    expect(socket.closeCount).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(requireController().isAvailable()).toBe(false);
  });

  it('parses an empty Responses completion without adding content', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const eventsPromise = collect(provider(MODEL, baseContext(), OPTIONS));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    await emitAll(
      socket,
      emptyEvents('resp_empty', {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
      }),
    );
    const events = await eventsPromise;
    const done = events.find((event) => event.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('Expected an empty completion.');
    expect(done.message.content).toEqual([]);
    expect(done.message.stopReason).toBe('stop');
    expect(done.message.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
  });

  it('leaves other incomplete Responses outcomes to the built-in parser', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const eventsPromise = collect(provider(MODEL, baseContext(), OPTIONS));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    await emitAll(
      socket,
      textEvents('resp_limited', 'limited answer').slice(0, -1),
    );
    socket.emit({
      type: 'response.incomplete',
      response: {
        id: 'resp_limited',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [textOutput('resp_limited', 'limited answer')],
        usage: FULL_USAGE,
      },
    });
    const events = await eventsPromise;
    const done = events.find((event) => event.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type !== 'done')
      throw new Error('Expected the built-in length completion.');
    expect(done.reason).toBe('length');
    expect(done.message.rawStopReason).toBe('incomplete.max_output_tokens');
  });

  it('turns only incomplete.steered into a successful partial and consumes its automatic successor without another create', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const context = baseContext();
    const rawEvents: unknown[] = [];
    const firstEventsPromise = collect(
      provider(MODEL, context, {
        ...OPTIONS,
        onProviderStreamEvent(event) {
          rawEvents.push(event);
        },
      }),
    );
    const socket = await waitForSocket(sockets);
    await socket.nextSent();

    const firstPrefix = textEvents('resp_steered', 'partial answer').slice(
      0,
      6,
    );
    await emitAll(socket, firstPrefix);
    const controller = requireController(OPTIONS.sessionId);
    await vi.waitFor(() => expect(controller.isAvailable()).toBe(true));

    let admit!: () => void;
    let finished = false;
    const accepted = controller.steer(
      'Add one more detail',
      () => new Promise<void>((resolve) => (admit = resolve)),
    );
    const steerEvent = await socket.nextSent();
    expect(steerEvent).toMatchObject({
      type: 'response.steer',
      previous_response_id: 'resp_steered',
      input: 'Add one more detail',
    });
    socket.emit({
      type: 'response.steer.accepted',
      sequence_number: 7,
      steer: { id: 'steer_accepted_1', previous_response_id: 'resp_steered' },
    });
    await vi.waitFor(() => expect(admit).toBeTypeOf('function'));

    const terminal = {
      type: 'response.incomplete',
      response: {
        id: 'resp_steered',
        status: 'incomplete',
        incomplete_details: { reason: 'steered' },
        output: [textOutput('resp_steered', 'partial answer')],
        usage: { input_tokens: 7 },
      },
    };
    socket.emit(terminal);
    void firstEventsPromise.then(() => (finished = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);

    admit();
    expect(await accepted).toEqual({
      status: 'accepted',
      steerId: 'steer_accepted_1',
    });
    const firstEvents = await firstEventsPromise;
    const firstDone = firstEvents.find((event) => event.type === 'done');
    expect(firstDone?.type).toBe('done');
    if (firstDone?.type !== 'done')
      throw new Error('Expected a partial done event.');
    expect(firstDone.reason).toBe('stop');
    expect(firstDone.message.rawStopReason).toBe('incomplete.steered');
    expect(rawEvents).toContainEqual(terminal);
    expect(firstDone.message.usage).toMatchObject({
      input: 7,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });

    await emitAll(socket, textEvents('resp_successor', 'continued'));
    const nextContext = addAssistantAndUser(
      context,
      firstDone.message,
      'Add one more detail',
    );
    const nextEvents = await collect(provider(MODEL, nextContext, OPTIONS));
    expect(nextEvents.some((event) => event.type === 'done')).toBe(true);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(1);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.steer'),
    ).toHaveLength(1);
  });

  it('creates one explicit continuation for pending client tool output and preserves ordinary queued input', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const context = baseContext();
    const options: SimpleStreamOptions = {
      ...OPTIONS,
      onPayload(payload) {
        return {
          ...(payload as JsonRecord),
          tools: [
            {
              type: 'function',
              name: 'lookup',
              description: 'Look up a value.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        };
      },
    };
    const firstEventsPromise = collect(provider(MODEL, context, options));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    socket.emit({
      type: 'response.created',
      response: { id: 'resp_tool', status: 'in_progress', output: [] },
    });
    const controller = requireController(OPTIONS.sessionId);
    await vi.waitFor(() => expect(controller.isAvailable()).toBe(true));
    const accepted = controller.steer('Use the latest result', () => undefined);
    const steerEvent = await socket.nextSent();
    socket.emit({
      type: 'response.steer.accepted',
      sequence_number: 3,
      steer: { id: 'steer_tool', previous_response_id: 'resp_tool' },
    });
    expect(await accepted).toEqual({
      status: 'accepted',
      steerId: 'steer_tool',
    });
    expect(steerEvent.type).toBe('response.steer');

    await emitAll(socket, toolEvents('resp_tool').slice(1));
    socket.emit({
      type: 'response.steer.pending',
      sequence_number: 9,
      steer: { id: 'steer_tool', previous_response_id: 'resp_tool' },
      reason: 'waiting_for_required_input',
      required_input: [
        {
          type: 'function_call_output',
          call_id: 'call_test_1',
          name: 'lookup',
        },
      ],
    });
    const firstEvents = await firstEventsPromise;
    const firstDone = firstEvents.find((event) => event.type === 'done');
    if (firstDone?.type !== 'done')
      throw new Error('Expected tool-use completion.');
    expect(firstDone.reason).toBe('toolUse');

    const toolResult = {
      role: 'toolResult',
      toolCallId: 'call_test_1|fc_test_1',
      toolName: 'lookup',
      content: [{ type: 'text', text: 'found it' }],
      isError: false,
      timestamp: 3,
    };
    const withToolAndSteer = {
      messages: [
        ...context.messages,
        firstDone.message,
        toolResult,
        {
          role: 'user',
          content: [{ type: 'text', text: 'Use the latest result' }],
          timestamp: 4,
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Also list the source' }],
          timestamp: 5,
        },
      ],
    } as TranscriptContext;
    const nextEventsPromise = collect(
      provider(MODEL, withToolAndSteer, options),
    );
    const create = await socket.nextSent();
    expect(create.type).toBe('response.create');
    expect(create.previous_response_id).toBe('resp_tool');
    expect(create.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_test_1',
        }),
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'input_text', text: 'Also list the source' }],
        }),
      ]),
    );
    expect(create.input).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'input_text', text: 'Use the latest result' }],
        }),
      ]),
    );
    expect(
      (create.input as JsonRecord[]).filter(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'call_test_1',
      ),
    ).toHaveLength(1);
    await emitAll(socket, textEvents('resp_after_tool', 'tool follow-up'));
    const nextEvents = await nextEventsPromise;
    expect(nextEvents.some((event) => event.type === 'done')).toBe(true);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(2);
  });

  it('allows steering after a normal completion and consumes its automatic continuation', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    let httpCalls = 0;
    const fallbackFetch: typeof globalThis.fetch = async () => {
      httpCalls++;
      return new Response(
        emptyEvents('resp_nested')
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const provider = createNativeSteeringStream(factory, fallbackFetch);
    const context = baseContext();
    const firstEventsPromise = collect(provider(MODEL, context, OPTIONS));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    await emitAll(socket, textEvents('resp_complete_first', 'first answer'));
    const firstEvents = await firstEventsPromise;
    const firstDone = firstEvents.find((event) => event.type === 'done');
    if (firstDone?.type !== 'done')
      throw new Error('Expected normal completion.');

    const controller = requireController(OPTIONS.sessionId);
    const accepted = controller.steer('Change the ending', () => undefined);
    await socket.nextSent();
    socket.emit({
      type: 'response.steer.accepted',
      sequence_number: 6,
      steer: {
        id: 'steer_after_complete',
        previous_response_id: 'resp_complete_first',
      },
    });
    expect(await accepted).toEqual({
      status: 'accepted',
      steerId: 'steer_after_complete',
    });
    const nextContext = addAssistantAndUser(
      context,
      firstDone.message,
      'Change the ending',
    );
    const nextEventsPromise = collect(provider(MODEL, nextContext, OPTIONS));
    const state = controller as typeof controller & {
      canStartNextRequest(): boolean;
    };
    await vi.waitFor(() => expect(state.canStartNextRequest()).toBe(false));
    const reentrantEvents = await collect(
      provider(MODEL, nextContext, OPTIONS),
    );
    expect(reentrantEvents.some((event) => event.type === 'done')).toBe(true);
    expect(httpCalls).toBe(1);

    await emitAll(
      socket,
      textEvents('resp_complete_successor', 'revised answer'),
    );
    const nextEvents = await nextEventsPromise;
    const successorDone = nextEvents.find((event) => event.type === 'done');
    if (successorDone?.type !== 'done')
      throw new Error('Expected the automatic continuation.');
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(1);

    const secondAccepted = controller.steer(
      'Change the ending again',
      () => undefined,
    );
    await socket.nextSent();
    socket.emit({
      type: 'response.steer.accepted',
      sequence_number: 9,
      steer: {
        id: 'steer_after_successor',
        previous_response_id: 'resp_complete_successor',
      },
    });
    expect(await secondAccepted).toMatchObject({ status: 'accepted' });
    const secondContext = addAssistantAndUser(
      nextContext,
      successorDone.message,
      'Change the ending again',
    );
    const secondEventsPromise = collect(
      provider(MODEL, secondContext, OPTIONS),
    );
    await vi.waitFor(() => expect(state.canStartNextRequest()).toBe(false));
    await emitAll(
      socket,
      textEvents('resp_complete_successor_2', 'second revised answer'),
    );
    const secondEvents = await secondEventsPromise;
    const secondDone = secondEvents.find((event) => event.type === 'done');
    if (secondDone?.type !== 'done')
      throw new Error('Expected the second automatic continuation.');

    const thirdContext = addAssistantAndUser(
      secondContext,
      secondDone.message,
      'One more change',
    );
    const thirdEventsPromise = collect(provider(MODEL, thirdContext, OPTIONS));
    const thirdCreate = await socket.nextSent();
    expect(thirdCreate).toMatchObject({
      type: 'response.create',
      previous_response_id: 'resp_complete_successor_2',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'One more change' }],
        },
      ],
    });
    await emitAll(socket, textEvents('resp_complete_third', 'third answer'));
    expect(
      (await thirdEventsPromise).some((event) => event.type === 'done'),
    ).toBe(true);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(2);
  });

  it('leaves the original response usable when steering is rejected', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const streamPromise = collect(provider(MODEL, baseContext(), OPTIONS));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    socket.emit({
      type: 'response.created',
      response: { id: 'resp_reject', status: 'in_progress', output: [] },
    });
    const controller = requireController(OPTIONS.sessionId);
    await vi.waitFor(() => expect(controller.isAvailable()).toBe(true));
    const onAccepted = vi.fn();
    const result = controller.steer('Not admitted', onAccepted);
    await socket.nextSent();
    socket.emit({
      type: 'response.steer.failed',
      sequence_number: 4,
      steer: {
        id: 'steer_rejected',
        previous_response_id: 'resp_reject',
        input: 'Not admitted',
      },
      error: {
        code: 'response_not_active',
        message: 'Response is no longer active.',
      },
    });
    expect(await result).toEqual({
      status: 'failed',
      message: 'Response is no longer active.',
    });
    expect(onAccepted).not.toHaveBeenCalled();
    await emitAll(
      socket,
      textEvents('resp_reject', 'original still completes').slice(1),
    );
    const events = await streamPromise;
    expect(events.some((event) => event.type === 'done')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(controller.isAvailable()).toBe(true);
  });

  it('returns unknown when native-message admission fails after OpenAI acceptance', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const eventsPromise = collect(provider(MODEL, baseContext(), OPTIONS));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    socket.emit({
      type: 'response.created',
      response: {
        id: 'resp_admission_failure',
        status: 'in_progress',
        output: [],
      },
    });
    const controller = requireController(OPTIONS.sessionId);
    await vi.waitFor(() => expect(controller.isAvailable()).toBe(true));
    const result = controller.steer('Accepted but not admitted', () => {
      throw new Error('Native queue rejected the message.');
    });
    await socket.nextSent();
    socket.emit({
      type: 'response.steer.accepted',
      sequence_number: 2,
      steer: {
        id: 'steer_admission_failure',
        previous_response_id: 'resp_admission_failure',
      },
    });

    expect(await result).toMatchObject({ status: 'unknown' });
    expect((await eventsPromise).some((event) => event.type === 'error')).toBe(
      true,
    );
    expect(controller.isAvailable()).toBe(false);
  });

  it('times out missing steering acknowledgments as unknown without replay', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const eventsPromise = collect(provider(MODEL, baseContext(), OPTIONS));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    socket.emit({
      type: 'response.created',
      response: { id: 'resp_ack_timeout', status: 'in_progress', output: [] },
    });
    const controller = requireController(OPTIONS.sessionId);
    await vi.waitFor(() => expect(controller.isAvailable()).toBe(true));
    vi.useFakeTimers();
    const result = controller.steer('Do not resend', () => undefined);
    await socket.nextSent();
    socket.emit({
      type: 'response.incomplete',
      response: {
        id: 'resp_ack_timeout',
        status: 'incomplete',
        incomplete_details: { reason: 'steered' },
        output: [],
      },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ status: 'unknown' });
    const events = await eventsPromise;
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(socket.closeCount).toBe(1);
    const tracked = controller as typeof controller & {
      segments: Map<string, unknown>;
      acceptedByResponse: Map<string, unknown>;
    };
    expect(tracked.segments.size).toBe(0);
    expect(tracked.acceptedByResponse.size).toBe(0);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.steer'),
    ).toHaveLength(1);
  });

  it('returns unknown on disconnect after send and never replays the request', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const firstEventsPromise = collect(provider(MODEL, baseContext(), OPTIONS));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    socket.emit({
      type: 'response.created',
      response: { id: 'resp_disconnect', status: 'in_progress', output: [] },
    });
    const controller = requireController(OPTIONS.sessionId);
    await vi.waitFor(() => expect(controller.isAvailable()).toBe(true));
    let admitted = false;
    const result = controller.steer('Do not replay', () => {
      admitted = true;
    });
    await socket.nextSent();
    socket.disconnect();
    expect(await result).toMatchObject({ status: 'unknown' });
    expect(admitted).toBe(false);
    const events = await firstEventsPromise;
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.steer'),
    ).toHaveLength(1);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(1);

    const retryEvents = await collect(provider(MODEL, baseContext(), OPTIONS));
    expect(retryEvents.some((event) => event.type === 'error')).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(1);
  });

  it.each([
    'settings',
    'context',
  ])('fails closed when continuation %s no longer matches', async (mismatch) => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const context = baseContext();
    const firstEventsPromise = collect(provider(MODEL, context, OPTIONS));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    await emitAll(socket, textEvents('resp_mismatch', 'answer'));
    const firstEvents = await firstEventsPromise;
    const firstDone = firstEvents.find((event) => event.type === 'done');
    if (firstDone?.type !== 'done')
      throw new Error('Expected initial completion.');
    const controller = requireController(OPTIONS.sessionId);
    const accepted = controller.steer('Continue exactly', () => undefined);
    await socket.nextSent();
    socket.emit({
      type: 'response.steer.accepted',
      sequence_number: 5,
      steer: { id: 'steer_mismatch', previous_response_id: 'resp_mismatch' },
    });
    await accepted;
    socket.emit({
      type: 'response.created',
      response: {
        id: 'resp_mismatch_successor',
        status: 'in_progress',
        output: [],
      },
    });
    const validNext = addAssistantAndUser(
      context,
      firstDone.message,
      'Continue exactly',
    );
    const badOptions: SimpleStreamOptions =
      mismatch === 'settings' ? { ...OPTIONS, maxTokens: 512 } : OPTIONS;
    const badContext =
      mismatch === 'context'
        ? addAssistantAndUser(
            baseContext('changed prompt'),
            firstDone.message,
            'Continue exactly',
          )
        : validNext;
    const events = await collect(provider(MODEL, badContext, badOptions));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(1);
  });

  it('prunes long request and tool histories while keeping steering available', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const toolOptions: SimpleStreamOptions = {
      ...OPTIONS,
      onPayload(payload) {
        return {
          ...(payload as JsonRecord),
          tools: [
            {
              type: 'function',
              name: 'lookup',
              description: 'Look up a value.',
              parameters: { type: 'object', properties: {} },
            },
          ],
        };
      },
    };
    let context = baseContext();
    let eventsPromise = collect(provider(MODEL, context, toolOptions));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    let finalMessage: AssistantMessage | undefined;

    for (let index = 0; index < 40; index++) {
      const responseId = `resp_chain_${index}`;
      await emitAll(
        socket,
        index === 20
          ? toolEvents(responseId)
          : textEvents(responseId, `answer ${index}`),
      );
      const events = await eventsPromise;
      const done = events.find((event) => event.type === 'done');
      if (done?.type !== 'done')
        throw new Error(`Expected completion ${index}.`);
      finalMessage = done.message;
      if (index === 20) {
        expect(done.reason).toBe('toolUse');
        context = {
          messages: [
            ...context.messages,
            done.message,
            {
              role: 'toolResult',
              toolCallId: 'call_test_1|fc_test_1',
              toolName: 'lookup',
              content: [{ type: 'text', text: 'found' }],
              isError: false,
              timestamp: index,
            },
            {
              role: 'user',
              content: [{ type: 'text', text: `continue ${index}` }],
              timestamp: index + 1,
            },
          ],
        } as TranscriptContext;
      } else if (index < 39) {
        context = addAssistantAndUser(
          context,
          done.message,
          `continue ${index}`,
        );
      }
      if (index < 39) {
        eventsPromise = collect(provider(MODEL, context, toolOptions));
        expect((await socket.nextSent()).type).toBe('response.create');
      }
    }

    const controller = requireController(OPTIONS.sessionId) as ReturnType<
      typeof requireController
    > & {
      segments: Map<string, unknown>;
      acceptedByResponse: Map<string, unknown>;
      canStartNextRequest(): boolean;
    };
    expect(controller.segments.size).toBe(1);
    expect(controller.acceptedByResponse.size).toBe(0);
    if (!finalMessage) throw new Error('Missing final chain response.');
    const accepted = controller.steer(
      'Steer after the long chain',
      () => undefined,
    );
    await socket.nextSent();
    socket.emit({
      type: 'response.steer.accepted',
      sequence_number: 1,
      steer: { id: 'steer_long_chain', previous_response_id: 'resp_chain_39' },
    });
    expect(await accepted).toMatchObject({ status: 'accepted' });

    const nextContext = addAssistantAndUser(
      context,
      finalMessage,
      'Steer after the long chain',
    );
    const nextEventsPromise = collect(
      provider(MODEL, nextContext, toolOptions),
    );
    await vi.waitFor(() =>
      expect(controller.canStartNextRequest()).toBe(false),
    );
    await emitAll(socket, textEvents('resp_chain_successor', 'continued'));
    expect(
      (await nextEventsPromise).some((event) => event.type === 'done'),
    ).toBe(true);
    expect(controller.segments.size).toBe(1);
    expect(controller.acceptedByResponse.size).toBe(0);
  });

  it('propagates a later provider request abort after synthetic headers', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const firstAbort = new AbortController();
    const firstEventsPromise = collect(
      provider(MODEL, baseContext(), { ...OPTIONS, signal: firstAbort.signal }),
    );
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    await emitAll(socket, textEvents('resp_abort_first', 'first answer'));
    const firstEvents = await firstEventsPromise;
    const firstDone = firstEvents.find((event) => event.type === 'done');
    if (firstDone?.type !== 'done')
      throw new Error('Expected the first completion.');

    const nextAbort = new AbortController();
    const nextEvents: AssistantMessageEvent[] = [];
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const nextEventsPromise = (async () => {
      for await (const event of provider(
        MODEL,
        addAssistantAndUser(
          baseContext(),
          firstDone.message,
          'Continue the response',
        ),
        { ...OPTIONS, signal: nextAbort.signal },
      )) {
        nextEvents.push(event);
        if (event.type === 'start') resolveStarted();
      }
    })();
    const create = await socket.nextSent();
    expect(create.type).toBe('response.create');
    socket.emit({
      type: 'response.created',
      response: { id: 'resp_abort_next', status: 'in_progress', output: [] },
    });
    await started;
    nextAbort.abort();
    await nextEventsPromise;
    expect(nextEvents.some((event) => event.type === 'error')).toBe(true);
    expect(socket.closeCount).toBe(1);
  });

  it.each([
    'settings',
    'tool loadout',
    'history',
  ])('restarts ordinary completed turns over HTTP when %s change', async (change) => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    let httpCalls = 0;
    const fallbackFetch: typeof globalThis.fetch = async () => {
      httpCalls++;
      return new Response(
        emptyEvents('resp_settings_fallback')
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const provider = createNativeSteeringStream(factory, fallbackFetch);
    const initialOptions: SimpleStreamOptions =
      change === 'tool loadout'
        ? {
            ...OPTIONS,
            onPayload(payload) {
              return {
                ...(payload as JsonRecord),
                tools: [{ type: 'function', name: 'lookup' }],
              };
            },
          }
        : OPTIONS;
    const context = baseContext();
    const firstEventsPromise = collect(
      provider(MODEL, context, initialOptions),
    );
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    await emitAll(socket, textEvents('resp_settings_first', 'first answer'));
    const firstEvents = await firstEventsPromise;
    const firstDone = firstEvents.find((event) => event.type === 'done');
    if (firstDone?.type !== 'done')
      throw new Error('Expected the initial completion.');

    const nextContext = addAssistantAndUser(
      context,
      firstDone.message,
      'Continue with changed settings',
    );
    const changedOptions: SimpleStreamOptions =
      change === 'tool loadout'
        ? {
            ...OPTIONS,
            onPayload(payload) {
              return {
                ...(payload as JsonRecord),
                tools: [{ type: 'function', name: 'other' }],
              };
            },
          }
        : change === 'settings'
          ? { ...OPTIONS, maxTokens: 512 }
          : OPTIONS;
    const changedContext =
      change === 'history'
        ? addAssistantAndUser(
            baseContext('changed earlier prompt'),
            firstDone.message,
            'Continue with changed settings',
          )
        : nextContext;
    const nextEvents = await collect(
      provider(MODEL, changedContext, changedOptions),
    );
    expect(nextEvents.some((event) => event.type === 'done')).toBe(true);
    expect(httpCalls).toBe(1);
    expect(socket.closeCount).toBe(1);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(1);
  });

  it('aborts the socket and closes session resources idempotently', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const abort = new AbortController();
    const eventsPromise = collect(
      provider(MODEL, baseContext(), { ...OPTIONS, signal: abort.signal }),
    );
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    socket.emit({
      type: 'response.created',
      response: { id: 'resp_abort', status: 'in_progress', output: [] },
    });
    abort.abort();
    const events = await eventsPromise;
    expect(
      events.some(
        (event) => event.type === 'error' && event.reason === 'aborted',
      ),
    ).toBe(true);
    expect(socket.closeCount).toBe(1);
    clearAllNativeSteeringControllers('reload');
    expect(socket.closeCount).toBe(1);
    expect(getNativeSteeringController(OPTIONS.sessionId)).toBeUndefined();
  });

  it('routes a reentrant request to scoped HTTP instead of consuming the active session socket', async () => {
    activateSession();
    const { factory, sockets } = makeSocketFactory();
    let httpCalls = 0;
    const fallbackFetch: typeof globalThis.fetch = async () => {
      httpCalls++;
      return new Response(
        emptyEvents('resp_nested')
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const provider = createNativeSteeringStream(factory, fallbackFetch);
    const activePromise = collect(provider(MODEL, baseContext(), OPTIONS));
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    socket.emit({
      type: 'response.created',
      response: { id: 'resp_active', status: 'in_progress', output: [] },
    });

    const nested = await collect(
      provider(MODEL, baseContext('nested request'), OPTIONS),
    );
    expect(nested.some((event) => event.type === 'done')).toBe(true);
    expect(httpCalls).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(
      socket.sentEvents.filter((event) => event.type === 'response.create'),
    ).toHaveLength(1);

    await emitAll(socket, textEvents('resp_active', 'active result').slice(1));
    expect((await activePromise).some((event) => event.type === 'done')).toBe(
      true,
    );
  });

  it('closes a live socket on extension reload and tolerates repeated cleanup', async () => {
    const sessionId = 'reload-session';
    setNativeSteeringAgentActive(sessionId, true);
    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    const eventsPromise = collect(
      provider(MODEL, baseContext(), { ...OPTIONS, sessionId }),
    );
    const socket = await waitForSocket(sockets);
    await socket.nextSent();
    socket.emit({
      type: 'response.created',
      response: { id: 'resp_reload', status: 'in_progress', output: [] },
    });
    await vi.waitFor(() =>
      expect(getNativeSteeringController(sessionId)?.isAvailable()).toBe(true),
    );

    clearAllNativeSteeringControllers('extension reloaded');
    expect(socket.closeCount).toBe(1);
    expect(getNativeSteeringController(sessionId)).toBeUndefined();
    clearAllNativeSteeringControllers('repeated cleanup');
    expect(socket.closeCount).toBe(1);
    expect((await eventsPromise).some((event) => event.type === 'error')).toBe(
      true,
    );
  });

  it('runs accepted steering and an automatic tool successor through AgentSession', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-steering-agent-'));
    let session:
      | Awaited<ReturnType<typeof createAgentSession>>['session']
      | undefined;
    const { factory, sockets } = makeSocketFactory();
    const payloads: JsonRecord[] = [];
    const errors: unknown[] = [];
    let toolCalls = 0;
    const nativeStream = createNativeSteeringStream(factory, async (input) => {
      errors.push(new Error(`Unexpected HTTP fallback: ${String(input)}`));
      throw new Error('AgentSession fixture must use its fake WebSocket.');
    });
    const streamSimple = (
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ) => {
      if (!isNativeSteeringEligible(model, options))
        throw new Error('AgentSession stream was ineligible.');
      return nativeStream(model, context, {
        ...options,
        async onPayload(payload) {
          const built = (await options?.onPayload?.(payload, model)) ?? payload;
          payloads.push(built as JsonRecord);
          return built;
        },
      });
    };
    const runtime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(root, 'models.sqlite'),
      refreshOnCreate: false,
    });
    runtime.registerProvider('openai', {
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: OPTIONS.apiKey,
      models: [
        {
          id: MODEL.id,
          name: MODEL.name,
          api: MODEL.api,
          input: MODEL.input,
          reasoning: true,
          cost: MODEL.cost,
          contextWindow: MODEL.contextWindow,
          maxTokens: MODEL.maxTokens,
        },
      ],
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const lifecycle: ExtensionFactory = (pi) => {
      pi.registerProvider('openai', {
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: OPTIONS.apiKey,
        streamSimple,
      });
      pi.on('agent_start', (_event, context) => {
        setNativeSteeringAgentActive(
          context.sessionManager.getSessionId(),
          true,
        );
      });
      pi.on('agent_end', (_event, context) => {
        setNativeSteeringAgentActive(
          context.sessionManager.getSessionId(),
          false,
        );
      });
      pi.registerTool({
        name: 'lookup',
        label: 'Lookup',
        description: 'Look up a value.',
        parameters: Type.Object({ key: Type.String() }),
        execute: async (_id, params) => {
          toolCalls++;
          return {
            content: [{ type: 'text', text: `found ${params.key}` }],
            details: {},
          };
        },
      });
    };
    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager: settings,
        noContextFiles: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [lifecycle],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const manager = SessionManager.inMemory(root);
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        modelRuntime: runtime,
        model: runtime.getModel('openai', MODEL.id),
        settingsManager: settings,
        sessionManager: manager,
        resourceLoader: loader,
        tools: ['lookup'],
      }));
      await session.bindExtensions({
        mode: 'rpc',
        onError: (error) => errors.push(error),
      });
      const promptPromise = session
        .prompt('Original request')
        .catch((error) => {
          errors.push(error);
        });
      const socket = await waitForSocket(sockets);
      const firstCreate = await socket.nextSent();
      expect(firstCreate.type).toBe('response.create');
      socket.emit({
        type: 'response.created',
        response: {
          id: 'resp_agent_partial',
          status: 'in_progress',
          output: [],
        },
      });
      const activeSession = session;
      if (!activeSession) throw new Error('Expected the AgentSession.');
      const controller = await vi.waitFor(() => {
        const value = getNativeSteeringController(activeSession.sessionId);
        if (!value?.isAvailable())
          throw new Error('Steering is not available yet.');
        return value;
      });
      const accepted = controller.steer('Native request', async () => {
        const result = await activeSession.steer('Native request');
        if (result !== 'queued')
          throw new Error(`Expected queued native input, received ${result}.`);
      });
      const steerEvent = await socket.nextSent();
      expect(steerEvent.type).toBe('response.steer');
      socket.emit({
        type: 'response.steer.accepted',
        sequence_number: 2,
        steer: {
          id: 'steer_agent_native',
          previous_response_id: 'resp_agent_partial',
        },
      });
      expect(await accepted).toMatchObject({ status: 'accepted' });
      await emitAll(
        socket,
        reasonedSteeredEvents(
          'resp_agent_partial',
          'original partial answer',
        ).slice(1),
      );

      const state = controller as typeof controller & {
        canStartNextRequest(): boolean;
      };
      await vi.waitFor(() => expect(state.canStartNextRequest()).toBe(false));
      expect(
        socket.sentEvents.filter((event) => event.type === 'response.create'),
      ).toHaveLength(1);
      await emitAll(socket, toolEvents('resp_agent_auto_tool'));
      await vi.waitFor(() => expect(toolCalls).toBe(1));
      const toolContinuation = await socket.nextSent();
      expect(toolContinuation).toMatchObject({
        type: 'response.create',
        previous_response_id: 'resp_agent_auto_tool',
      });
      expect(
        (toolContinuation.input as JsonRecord[]).filter(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === 'call_test_1',
        ),
      ).toHaveLength(1);
      const autoInput = payloads[1]?.input;
      if (!Array.isArray(autoInput))
        throw new Error('Missing automatic input history.');
      expect(autoInput).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'reasoning',
            encrypted_content: 'native-reasoning-signature',
          }),
          expect.objectContaining({
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
          }),
          expect.objectContaining({
            role: 'user',
            content: [{ type: 'input_text', text: 'Native request' }],
          }),
        ]),
      );

      await emitAll(socket, textEvents('resp_agent_final', 'final answer'));
      await promptPromise;
      expect(errors).toEqual([]);
      expect(toolCalls).toBe(1);
      expect(
        socket.sentEvents.filter((event) => event.type === 'response.create'),
      ).toHaveLength(2);
      const messages = session.messages;
      const partialIndex = messages.findIndex(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              block.type === 'text' && block.text === 'original partial answer',
          ),
      );
      const nativeIndex = messages.findIndex(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block.type === 'text' && block.text === 'Native request',
          ),
      );
      const successorIndex = messages.findIndex(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block.type === 'toolCall' && block.name === 'lookup',
          ),
      );
      expect(partialIndex).toBeGreaterThanOrEqual(0);
      expect(nativeIndex).toBeGreaterThan(partialIndex);
      expect(successorIndex).toBeGreaterThan(nativeIndex);
      const partial = messages[partialIndex];
      if (partial?.role !== 'assistant')
        throw new Error('Missing partial response.');
      expect(partial.rawStopReason).toBe('incomplete.steered');
    } finally {
      session?.dispose();
      clearAllNativeSteeringControllers('AgentSession test cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps unsupported model, endpoint, auth, and fetch configurations on built-in HTTP', async () => {
    activateSession();
    const cases: Array<{
      name: string;
      model: Model<Api>;
      options: SimpleStreamOptions;
    }> = [
      {
        name: 'unsupported model',
        model: { ...MODEL, id: 'gpt-5.6' },
        options: OPTIONS,
      },
      {
        name: 'custom endpoint',
        model: { ...MODEL, baseUrl: 'https://proxy.example/v1' },
        options: OPTIONS,
      },
      {
        name: 'subscription token',
        model: MODEL,
        options: { ...OPTIONS, apiKey: 'chatgpt-access-token' },
      },
      {
        name: 'custom fetch',
        model: MODEL,
        options: { ...OPTIONS, fetch: async () => new Response() },
      },
    ];
    for (const testCase of cases)
      expect(
        isNativeSteeringEligible(testCase.model, testCase.options),
        testCase.name,
      ).toBe(false);
    expect(isNativeSteeringEligible(MODEL, OPTIONS)).toBe(true);

    const { factory, sockets } = makeSocketFactory();
    const provider = createNativeSteeringStream(factory);
    let httpCalls = 0;
    const events = await collect(
      provider(MODEL, baseContext(), {
        ...OPTIONS,
        fetch: async (_input, _init) => {
          httpCalls++;
          return new Response(
            emptyEvents('resp_http_fallback')
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(''),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        },
      }),
    );
    expect(events.some((event) => event.type === 'done')).toBe(true);
    expect(httpCalls).toBe(1);
    expect(sockets).toHaveLength(0);
  });
});
