import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai/compat';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markLogicalSteering } from '../shared/runtime/logical-input';
import {
  clearAllNativeSteeringControllers,
  getNativeSteeringController,
  setNativeSteeringAgentActive,
} from '../shared/runtime/native-steering';
import type { ResponsesSocket, ResponsesSocketFactory } from './controller';
import {
  createNativeSteeringStream,
  installNativeSteeringLifecycle,
} from './index';

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type RecordValue = Record<string, unknown>;

type SocketEventLike =
  | { type: 'open' }
  | { type: 'message'; message: unknown }
  | { type: 'error'; error: unknown }
  | { type: 'close'; code?: number; reason?: string };

class FakeSocket implements ResponsesSocket {
  readonly sent: RecordValue[] = [];
  closeCount = 0;
  failNextSend = false;
  private readonly incoming: SocketEventLike[] = [];
  private readonly waiters: Array<(event: SocketEventLike) => void> = [];

  send(event: RecordValue): void {
    this.sent.push(event);
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('create write outcome unknown');
    }
  }

  async *stream(): AsyncIterable<SocketEventLike> {
    yield { type: 'open' };
    while (true) {
      const event = await new Promise<SocketEventLike>((resolve) => {
        const next = this.incoming.shift();
        if (next) resolve(next);
        else this.waiters.push(resolve);
      });
      yield event;
      if (event.type === 'close') return;
    }
  }

  emit(message: RecordValue): void {
    const event: SocketEventLike = { type: 'message', message };
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.incoming.push(event);
  }

  disconnect(): void {
    const event: SocketEventLike = {
      type: 'close',
      code: 1006,
      reason: 'lost',
    };
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.incoming.push(event);
  }

  close(): void {
    this.closeCount++;
    this.disconnect();
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
const sessionId = 'native-lifecycle-session';
const options: SimpleStreamOptions = {
  apiKey: 'sk-test-key-not-used-for-network',
  sessionId,
  maxRetries: 0,
};
const context: TranscriptContext = {
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'prompt' }], timestamp: 1 },
  ],
} as TranscriptContext;

function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  return (async () => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  })();
}

async function createAgentHarness(
  factory: ResponsesSocketFactory,
  fallbackFetch: typeof globalThis.fetch,
) {
  const root = await mkdtemp(join(tmpdir(), 'native-lifecycle-followup-'));
  const runtime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models.sqlite'),
    refreshOnCreate: false,
  });
  runtime.registerProvider('openai', {
    api: 'openai-responses',
    baseUrl: MODEL.baseUrl,
    apiKey: options.apiKey,
    models: [
      {
        id: MODEL.id,
        name: MODEL.name,
        api: MODEL.api,
        input: MODEL.input,
        reasoning: MODEL.reasoning,
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
  let providerCalls = 0;
  const controllersAtProviderCall: Array<unknown> = [];
  const nativeStream = createNativeSteeringStream(factory, fallbackFetch);
  const lifecycle: ExtensionFactory = (pi) => {
    pi.registerProvider('openai', {
      api: 'openai-responses',
      baseUrl: MODEL.baseUrl,
      apiKey: options.apiKey,
      streamSimple(model, transcript, streamOptions) {
        providerCalls++;
        controllersAtProviderCall.push(
          streamOptions?.sessionId
            ? getNativeSteeringController(streamOptions.sessionId)
            : undefined,
        );
        return nativeStream(model, transcript, streamOptions);
      },
    });
    installNativeSteeringLifecycle(pi);
  };
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
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    model: runtime.getModel('openai', MODEL.id),
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(root),
    resourceLoader: loader,
  });
  await session.bindExtensions({ mode: 'rpc', onError: () => undefined });
  return {
    session,
    controllersAtProviderCall,
    get providerCalls() {
      return providerCalls;
    },
    async cleanup() {
      session.dispose();
      clearAllNativeSteeringControllers('AgentSession follow-up test cleanup');
      await rm(root, { recursive: true, force: true });
    },
  };
}

function lifecycleHarness() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  installNativeSteeringLifecycle(pi);
  const entries: Array<RecordValue> = [
    { type: 'message', id: 'prompt-1', message: { role: 'user' } },
  ];
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
  } as unknown as ExtensionContext;
  const fire = (name: string) => handlers.get(name)?.(undefined as never, ctx);
  return { entries, ctx, fire };
}

afterEach(() => {
  clearAllNativeSteeringControllers('native lifecycle test cleanup');
});

describe('native steering lifecycle', () => {
  it('blocks the AgentSession queued continuation after a disconnect post-acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-lifecycle-agent-'));
    let session:
      | Awaited<ReturnType<typeof createAgentSession>>['session']
      | undefined;
    const sockets: FakeSocket[] = [];
    const fallbackFetch = vi.fn<typeof globalThis.fetch>();
    let providerCalls = 0;
    const factory: ResponsesSocketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const nativeStream = createNativeSteeringStream(factory, fallbackFetch);
    const runtime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(root, 'models.sqlite'),
      refreshOnCreate: false,
    });
    runtime.registerProvider('openai', {
      api: 'openai-responses',
      baseUrl: MODEL.baseUrl,
      apiKey: options.apiKey,
      models: [
        {
          id: MODEL.id,
          name: MODEL.name,
          api: MODEL.api,
          input: MODEL.input,
          reasoning: MODEL.reasoning,
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
        baseUrl: MODEL.baseUrl,
        apiKey: options.apiKey,
        streamSimple(model, transcript, streamOptions) {
          providerCalls++;
          return nativeStream(model, transcript, streamOptions);
        },
      });
      installNativeSteeringLifecycle(pi);
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
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        modelRuntime: runtime,
        model: runtime.getModel('openai', MODEL.id),
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(root),
        resourceLoader: loader,
      }));
      const errors: unknown[] = [];
      await session.bindExtensions({
        mode: 'rpc',
        onError: (error) => errors.push(error),
      });
      const activeSession = session;
      const agent = activeSession.agent as unknown as {
        steer: (message: { role?: string }) => void;
      };
      const originalSteer = agent.steer.bind(agent);
      agent.steer = (message) => {
        if (message.role === 'user') markLogicalSteering(message);
        originalSteer(message);
      };
      const prompt = activeSession.prompt('Original request').catch((error) => {
        errors.push(error);
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0];
      if (!socket) throw new Error('Expected the initial fake socket.');
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
      socket.emit({
        type: 'response.created',
        response: {
          id: 'resp_lifecycle_partial',
          status: 'in_progress',
          output: [],
        },
      });
      const controller = await vi.waitFor(() => {
        const value = getNativeSteeringController(activeSession.sessionId);
        if (!value?.isAvailable())
          throw new Error('Native controller unavailable.');
        return value;
      });
      const accepted = controller.steer('User A', async () => {
        const disposition = await activeSession.steer('User A');
        if (disposition !== 'queued')
          throw new Error(`Expected queued input, received ${disposition}.`);
      });
      socket.emit({
        type: 'response.steer.accepted',
        sequence_number: 2,
        steer: {
          id: 'steer_lifecycle_a',
          previous_response_id: 'resp_lifecycle_partial',
        },
      });
      expect(await accepted).toMatchObject({ status: 'accepted' });
      socket.disconnect();
      await prompt;
      await vi.waitFor(() => expect(providerCalls).toBeGreaterThan(1));
      expect(sockets).toHaveLength(1);
      expect(
        socket.sent.filter((event) => event.type === 'response.create'),
      ).toHaveLength(1);
      expect(fallbackFetch).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      expect(getNativeSteeringController(activeSession.sessionId)).toBe(
        controller,
      );
      expect(
        activeSession.messages.filter(
          (message) =>
            message.role === 'user' &&
            Array.isArray(message.content) &&
            message.content.some(
              (block) => block.type === 'text' && block.text === 'User A',
            ),
        ),
      ).toHaveLength(1);

      const freshPrompt = activeSession
        .prompt('Genuinely fresh request')
        .catch((error) => errors.push(error));
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      const freshSocket = sockets[1];
      if (!freshSocket) throw new Error('Expected fresh-request socket.');
      await vi.waitFor(() => expect(freshSocket.sent).toHaveLength(1));
      freshSocket.emit({
        type: 'response.created',
        response: {
          id: 'resp_lifecycle_fresh',
          status: 'in_progress',
          output: [],
        },
      });
      freshSocket.emit({
        type: 'response.completed',
        response: {
          id: 'resp_lifecycle_fresh',
          status: 'completed',
          output: [],
        },
      });
      await freshPrompt;
      expect(errors).toEqual([]);
      expect(
        freshSocket.sent.filter((event) => event.type === 'response.create'),
      ).toHaveLength(1);
      expect(
        getNativeSteeringController(activeSession.sessionId),
      ).toBeUndefined();
    } finally {
      session?.dispose();
      clearAllNativeSteeringControllers('AgentSession lifecycle test cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });
  it('allows a queued fresh follow-up after blocking the automatic native continuation', async () => {
    const sockets: FakeSocket[] = [];
    const fallbackFetch = vi.fn<typeof globalThis.fetch>();
    const factory: ResponsesSocketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const fixture = await createAgentHarness(factory, fallbackFetch);
    const activeSession = fixture.session;
    const errors: unknown[] = [];
    const agent = activeSession.agent as unknown as {
      steer: (message: { role?: string }) => void;
    };
    const originalSteer = agent.steer.bind(agent);
    agent.steer = (message) => {
      if (message.role === 'user') markLogicalSteering(message);
      originalSteer(message);
    };
    try {
      const prompt = activeSession.prompt('Original request').catch((error) => {
        errors.push(error);
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const firstSocket = sockets[0];
      if (!firstSocket) throw new Error('Expected the initial fake socket.');
      await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));
      firstSocket.emit({
        type: 'response.created',
        response: {
          id: 'resp_lifecycle_followup',
          status: 'in_progress',
          output: [],
        },
      });
      const controller = await vi.waitFor(() => {
        const value = getNativeSteeringController(activeSession.sessionId);
        if (!value?.isAvailable())
          throw new Error('Native controller unavailable.');
        return value;
      });
      const accepted = controller.steer('User A', async () => {
        const disposition = await activeSession.steer('User A');
        if (disposition !== 'queued')
          throw new Error(`Expected queued input, received ${disposition}.`);
      });
      firstSocket.emit({
        type: 'response.steer.accepted',
        sequence_number: 2,
        steer: {
          id: 'steer_lifecycle_followup_a',
          previous_response_id: 'resp_lifecycle_followup',
        },
      });
      expect(await accepted).toMatchObject({ status: 'accepted' });
      expect(await activeSession.followUp('Fresh queued follow-up')).toBe(
        'queued',
      );
      firstSocket.disconnect();

      await vi.waitFor(() => expect(fixture.providerCalls).toBeGreaterThan(1));
      expect(fixture.controllersAtProviderCall[1]).toBe(controller);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      const followUpSocket = sockets[1];
      if (!followUpSocket)
        throw new Error('Expected the queued follow-up socket.');
      await vi.waitFor(() => expect(followUpSocket.sent).toHaveLength(1));
      expect(fixture.controllersAtProviderCall[2]).toBeUndefined();
      followUpSocket.emit({
        type: 'response.created',
        response: {
          id: 'resp_lifecycle_followup_done',
          status: 'in_progress',
          output: [],
        },
      });
      followUpSocket.emit({
        type: 'response.completed',
        response: {
          id: 'resp_lifecycle_followup_done',
          status: 'completed',
          output: [],
        },
      });
      await prompt;
      expect(errors).toEqual([]);
      expect(fallbackFetch).not.toHaveBeenCalled();
      expect(
        followUpSocket.sent.filter((event) => event.type === 'response.create'),
      ).toHaveLength(1);
      expect(
        getNativeSteeringController(activeSession.sessionId),
      ).toBeUndefined();
      for (const text of ['User A', 'Fresh queued follow-up'])
        expect(
          activeSession.messages.filter(
            (message) =>
              message.role === 'user' &&
              Array.isArray(message.content) &&
              message.content.some(
                (block) => block.type === 'text' && block.text === text,
              ),
          ),
        ).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps an unknown initial write pinned through an AgentSession retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-lifecycle-retry-'));
    let session:
      | Awaited<ReturnType<typeof createAgentSession>>['session']
      | undefined;
    const sockets: FakeSocket[] = [];
    const fallbackFetch = vi.fn<typeof globalThis.fetch>();
    let providerCalls = 0;
    const factory: ResponsesSocketFactory = () => {
      const socket = new FakeSocket();
      socket.failNextSend = true;
      sockets.push(socket);
      return socket;
    };
    const runtime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(root, 'models.sqlite'),
      refreshOnCreate: false,
    });
    runtime.registerProvider('openai', {
      api: MODEL.api,
      baseUrl: MODEL.baseUrl,
      apiKey: options.apiKey,
      models: [
        {
          id: MODEL.id,
          name: MODEL.name,
          api: MODEL.api,
          input: MODEL.input,
          reasoning: MODEL.reasoning,
          cost: MODEL.cost,
          contextWindow: MODEL.contextWindow,
          maxTokens: MODEL.maxTokens,
        },
      ],
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    });
    const lifecycle: ExtensionFactory = (pi) => {
      pi.registerProvider('openai', {
        api: MODEL.api,
        baseUrl: MODEL.baseUrl,
        apiKey: options.apiKey,
        streamSimple(model, transcript, streamOptions) {
          providerCalls++;
          return createNativeSteeringStream(factory, fallbackFetch)(
            model,
            transcript,
            streamOptions,
          );
        },
      });
      installNativeSteeringLifecycle(pi);
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
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        modelRuntime: runtime,
        model: runtime.getModel('openai', MODEL.id),
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(root),
        resourceLoader: loader,
      }));
      await session.bindExtensions({ mode: 'rpc', onError: () => undefined });
      await session.prompt('Original request').catch(() => undefined);
      await vi.waitFor(() => expect(providerCalls).toBeGreaterThan(1));
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.sent).toHaveLength(1);
      expect(fallbackFetch).not.toHaveBeenCalled();
      expect(
        getNativeSteeringController(session.sessionId)?.isAvailable(),
      ).toBe(false);
    } finally {
      session?.dispose();
      clearAllNativeSteeringControllers('AgentSession retry test cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a healthy controller when a fresh user entry appears, then clears at agent_end', async () => {
    const { entries, fire } = lifecycleHarness();
    const sockets: FakeSocket[] = [];
    const factory: ResponsesSocketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    setNativeSteeringAgentActive(sessionId, true);
    const provider = createNativeSteeringStream(factory);
    const events = collect(provider(MODEL, context, options));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    if (!socket) throw new Error('Expected a fake socket.');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.emit({
      type: 'response.created',
      response: { id: 'resp_healthy', status: 'in_progress', output: [] },
    });
    socket.emit({
      type: 'response.completed',
      response: { id: 'resp_healthy', status: 'completed', output: [] },
    });
    await events;
    const healthyController = getNativeSteeringController(sessionId);
    expect(healthyController).toBeDefined();
    fire('context');
    entries.push({ type: 'message', id: 'fresh-2', message: { role: 'user' } });
    fire('context');
    expect(getNativeSteeringController(sessionId)).toBe(healthyController);
    fire('agent_end');
    expect(getNativeSteeringController(sessionId)).toBeUndefined();
    expect(socket.closeCount).toBe(1);
  });

  it('retains a failed create write as a tombstone across agent_end', async () => {
    const { fire } = lifecycleHarness();
    const sockets: FakeSocket[] = [];
    const factory: ResponsesSocketFactory = () => {
      const socket = new FakeSocket();
      socket.failNextSend = true;
      sockets.push(socket);
      return socket;
    };
    const httpFetch = vi.fn<typeof globalThis.fetch>();
    setNativeSteeringAgentActive(sessionId, true);
    const provider = createNativeSteeringStream(factory, httpFetch);
    await collect(provider(MODEL, context, options));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toHaveLength(1);
    fire('agent_end');

    const retry = await collect(provider(MODEL, context, options));
    expect(retry.some((event) => event.type === 'error')).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('retains uncertain sent requests through agent_end and resets only for a fresh user entry', async () => {
    const { entries, fire } = lifecycleHarness();
    const sockets: FakeSocket[] = [];
    const factory: ResponsesSocketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const httpFetch = vi.fn<typeof globalThis.fetch>();
    setNativeSteeringAgentActive(sessionId, true);
    const provider = createNativeSteeringStream(factory, httpFetch);
    const first = collect(provider(MODEL, context, options));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0]?.disconnect();
    await first;
    fire('agent_end');

    const tombstone = getNativeSteeringController(sessionId);
    expect(tombstone).toBeDefined();
    expect(tombstone?.isAvailable()).toBe(false);
    const unsupported = collect(
      provider({ ...MODEL, id: 'unsupported-model' }, context, options),
    );
    expect((await unsupported).some((event) => event.type === 'error')).toBe(
      true,
    );
    expect(httpFetch).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);

    entries.push({ type: 'message', id: 'fresh-2', message: { role: 'user' } });
    fire('context');
    expect(getNativeSteeringController(sessionId)).toBeUndefined();

    setNativeSteeringAgentActive(sessionId, true);
    const fresh = collect(provider(MODEL, context, options));
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]?.sent).toHaveLength(1);
    sockets[1]?.disconnect();
    await fresh;
  });
});
