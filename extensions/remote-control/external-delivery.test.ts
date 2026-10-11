import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  type BridgeImageAttachment,
  externalDeliveryReceipt,
} from '@pi-dashboard/protocol';
import { Type } from 'typebox';
import { afterEach, expect, it, vi } from 'vitest';
import {
  clearAllNativeSteeringControllers,
  registerNativeSteeringController,
} from '../shared/runtime/native-steering';
import { getScopedServices } from '../shared/runtime/scoped-services';
import { registerSteeringMessageTracking } from '../steering-messages';
import { dispatchDashboardCommand } from './command-dispatcher';
import {
  installExternalDeliveryReceipts,
  installExternalSteeringShim,
  installQueueAgentObservation,
  withQueueSendObservation,
} from './external-delivery';
import {
  nativeSteeringContribution,
  QUEUE_STEER_NOW_ACTION_ID,
} from './native-steering';
import { QueueDraftStore } from './queue-draft-store';
import {
  installRequestClosureBoundary,
  RequestClosureLifecycle,
} from './request-closure';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  clearAllNativeSteeringControllers('test cleanup');
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  extra?: ExtensionFactory,
  before = false,
  imageAutoResize: boolean | null = false,
  activeTool = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'native-delivery-sdk-'));
  let session: AgentSession | undefined;
  cleanups.push(async () => {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const toolStarted = vi.fn();
  const contexts: Context[] = [];
  const errors: unknown[] = [];
  let pi!: ExtensionAPI;
  let ctx!: ExtensionContext;
  const runtime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models.sqlite'),
    refreshOnCreate: false,
  });
  runtime.registerProvider('fixture', {
    baseUrl: 'http://fixture.invalid',
    apiKey: 'fixture',
    api: 'openai-completions',
    models: [
      {
        id: 'fixture',
        name: 'Fixture',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16000,
        maxTokens: 1000,
      },
    ],
    streamSimple: (_model, context) => {
      contexts.push(structuredClone(context));
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: 'done',
          reason: activeTool && contexts.length === 1 ? 'toolUse' : 'stop',
          message: {
            role: 'assistant',
            content:
              activeTool && contexts.length === 1
                ? [
                    {
                      type: 'toolCall',
                      id: 'gate-call',
                      name: 'gate',
                      arguments: {},
                    },
                  ]
                : [{ type: 'text', text: 'fixture answer' }],
            api: 'openai-completions',
            provider: 'fixture',
            model: 'fixture',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason:
              activeTool && contexts.length === 1 ? 'toolUse' : 'stop',
            timestamp: Date.now(),
          },
        });
        stream.end();
      });
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    // Keep the existing fixture focused on native delivery identity, not
    // optional 0.87 image normalization hints. Pass null below to test
    // the SDK default instead.
    ...(imageAutoResize === null
      ? {}
      : { images: { autoResize: imageAutoResize } }),
  });
  const manager = SessionManager.create(root, join(root, 'sessions'));
  const closure = new RequestClosureLifecycle();
  const core: ExtensionFactory = (api) => {
    pi = api;
    installRequestClosureBoundary(api, closure);
    registerSteeringMessageTracking(api);
    installExternalDeliveryReceipts(api);
    installExternalSteeringShim();
    if (activeTool)
      api.registerTool({
        name: 'gate',
        label: 'Gate',
        description: 'Model-free boundary fixture',
        parameters: Type.Object({}),
        execute: async () => {
          toolStarted();
          await toolGate;
          return { content: [{ type: 'text', text: 'released' }], details: {} };
        },
      });
    api.on('session_start', (_event, context) => {
      ctx = context;
    });
  };
  const extras = extra ? [extra] : [];
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: before ? [...extras, core] : [core, ...extras],
  });
  await loader.reload();
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    model: runtime.getModel('fixture', 'fixture'),
    settingsManager: settings,
    sessionManager: manager,
    resourceLoader: loader,
    ...(activeTool ? { tools: ['gate'] } : { noTools: 'all' as const }),
  }));
  await session.bindExtensions({
    mode: 'rpc',
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    root,
    session,
    pi,
    ctx,
    manager,
    contexts,
    errors,
    closure,
    abort() {
      return dispatchDashboardCommand(pi, ctx, { id: 'abort', type: 'abort' });
    },
    register(id: string) {
      return getScopedServices(
        manager.getSessionId(),
      ).requestDependencies?.register('process', id, ctx);
    },
    complete(id: string) {
      pi.sendMessage(
        {
          customType: 'background-terminal-result',
          content: 'required result',
          display: true,
          details: { id, status: 'done' },
        },
        { triggerTurn: true, deliverAs: 'steer' },
      );
    },
    releaseTool,
    toolStarted,
    followUp(id: string, text: string) {
      return dispatchDashboardCommand(pi, ctx, { id, type: 'followUp', text });
    },
    nativeSteer(id: string, text: string) {
      return dispatchDashboardCommand(pi, ctx, { id, type: 'steer', text });
    },
    steer(
      id: string,
      text: string,
      expectedSessionId = manager.getSessionId(),
      expectedLeafId = manager.getLeafId() ?? undefined,
    ) {
      return dispatchDashboardCommand(pi, ctx, {
        id,
        type: 'steer',
        externalDeliveryId: id,
        text,
        expectedSessionId,
        ...(expectedLeafId ? { expectedLeafId } : {}),
      });
    },
    async send(
      deliveryId: string,
      text: string,
      images?: BridgeImageAttachment[],
    ) {
      const count = contexts.length;
      await dispatchDashboardCommand(pi, ctx, {
        id: deliveryId,
        type: 'prompt',
        externalDeliveryId: deliveryId,
        text,
        ...(images ? { images } : {}),
      });
      await vi.waitFor(() => expect(contexts).toHaveLength(count + 1));
      await session.waitForIdle();
    },
    dispatch(
      deliveryId: string,
      text: string,
      expectedSessionId?: string,
      expectedLeafId?: string,
    ) {
      return dispatchDashboardCommand(pi, ctx, {
        id: deliveryId,
        type: 'prompt',
        externalDeliveryId: deliveryId,
        text,
        ...(expectedSessionId ? { expectedSessionId } : {}),
        ...(expectedLeafId ? { expectedLeafId } : {}),
      });
    },
  };
}

it('observes the SDK send promise hidden by the extension API wrapper', async () => {
  const f = await fixture();
  const outcomes: unknown[] = [];
  const entries: string[] = [];
  const send = withQueueSendObservation(
    () =>
      f.pi.sendUserMessage('observed queue input', { deliverAs: 'followUp' }),
    (outcome) => outcomes.push(outcome),
    () => entries.push('entered'),
  );
  expect(send.observed).toBe(true);
  expect(send.result).toBeUndefined();
  await vi.waitFor(() => expect(outcomes).toEqual([{ status: 'accepted' }]));
  await vi.waitFor(() => expect(entries).toEqual(['entered']));
  expect(
    f.contexts
      .at(-1)
      ?.messages.some(
        (message) =>
          message.role === 'user' &&
          (typeof message.content === 'string'
            ? message.content === 'observed queue input'
            : message.content.some(
                (part) =>
                  part.type === 'text' && part.text === 'observed queue input',
              )),
      ),
  ).toBe(true);
});

it('refreshes retained agent wrappers after extension module reinstall', async () => {
  const steer = vi.fn();
  const agent = {
    steer,
    followUp: vi.fn(),
    prompt: vi.fn(),
  };
  const session = { agent } as unknown as AgentSession;
  expect(installQueueAgentObservation(session)).toBe(true);

  vi.resetModules();
  const reloaded = await import('./external-delivery.js');
  expect(reloaded.installQueueAgentObservation(session)).toBe(true);
  const message = { role: 'user', content: 'same native object' };
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => void
  >();
  reloaded.installExternalDeliveryReceipts({
    on: (
      event: string,
      handler: (value: unknown, ctx: ExtensionContext) => void,
    ) => handlers.set(event, handler),
  } as unknown as ExtensionAPI);
  const entered = vi.fn();
  reloaded.withQueueSendObservation(
    () => agent.steer(message),
    () => undefined,
    entered,
  );
  const branch = [{ id: 'entry-after-reload', type: 'message', message }];
  const ctx = {
    sessionManager: {
      getSessionId: () => 'reload-session',
      getBranch: () => branch,
      getEntries: () => branch,
    },
  } as unknown as ExtensionContext;
  handlers.get('message_end')?.({ message }, ctx);
  handlers.get('context')?.({}, ctx);
  expect(entered).toHaveBeenCalledOnce();
  expect(steer).toHaveBeenCalledWith(message);
  expect(
    installQueueAgentObservation({
      agent: { ...agent, prompt: undefined },
    } as unknown as AgentSession),
  ).toBe(false);
});

it('observes real streaming queue entries by native identity for duplicate text', async () => {
  const f = await fixture(undefined, false, false, true);
  const turn = f.session.prompt('Start the tool.');
  await vi.waitFor(() => expect(f.toolStarted).toHaveBeenCalledOnce());
  const entered = [vi.fn(), vi.fn()];
  const outcomes: unknown[] = [];
  for (const onEntered of entered) {
    const result = withQueueSendObservation(
      () => f.pi.sendUserMessage('same queued text', { deliverAs: 'steer' }),
      (outcome) => outcomes.push(outcome),
      onEntered,
    );
    expect(result).toMatchObject({ observed: true, result: undefined });
  }
  await vi.waitFor(() => expect(outcomes).toHaveLength(2));
  expect(outcomes).toEqual([{ status: 'accepted' }, { status: 'accepted' }]);
  f.releaseTool();
  await turn;
  await f.session.waitForIdle();
  await vi.waitFor(() => {
    expect(entered[0]).toHaveBeenCalledOnce();
    expect(entered[1]).toHaveBeenCalledOnce();
  });
  const users = f.manager
    .getBranch()
    .filter(
      (entry) =>
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        JSON.stringify(entry.message.content).includes('same queued text'),
    );
  expect(users).toHaveLength(2);
  expect(new Set(users.map((entry) => entry.id)).size).toBe(2);
  expect(
    f.contexts
      .at(-1)
      ?.messages.filter(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('same queued text'),
      ),
  ).toHaveLength(2);
  expect(f.errors).toEqual([]);
});

it('queues identical literal steering inputs during a real SDK tool and processes them at the next boundary', async () => {
  const f = await fixture(undefined, false, false, true);
  const turn = f.session.prompt('Start the tool.');
  await vi.waitFor(() => expect(f.toolStarted).toHaveBeenCalledOnce());
  const anchor = f.manager.getLeafId();
  if (!anchor) throw new Error('Missing native branch anchor.');
  expect(
    await f.steer('steer-1', '/quit', f.manager.getSessionId(), anchor),
  ).toMatchObject({ accepted: true, mode: 'steer' });
  expect(
    await f.steer('steer-2', '/quit', f.manager.getSessionId(), anchor),
  ).toMatchObject({ accepted: true, mode: 'steer' });
  expect(f.contexts).toHaveLength(1);
  await expect(
    f.steer('wrong-session', 'No', 'replaced-session', anchor),
  ).rejects.toMatchObject({ code: 'orchestration-conflict' });
  await expect(
    f.steer('wrong-branch', 'No', f.manager.getSessionId(), 'removed-anchor'),
  ).rejects.toMatchObject({ code: 'orchestration-conflict' });
  f.releaseTool();
  await turn;
  await f.session.waitForIdle();
  await expect(
    f.steer('idle-race', 'Do not start a new turn'),
  ).rejects.toMatchObject({ code: 'busy' });
  const users = f.contexts
    .at(-1)
    ?.messages.filter((message) => message.role === 'user');
  const steered = users?.filter((message) =>
    JSON.stringify(message.content).includes('/quit'),
  );
  expect(steered).toHaveLength(2);
  const receipts = f.manager
    .getBranch()
    .map(externalDeliveryReceipt)
    .filter((item): item is NonNullable<typeof item> =>
      Boolean(item && ['steer-1', 'steer-2'].includes(item.deliveryId)),
    );
  expect(receipts).toHaveLength(2);
  expect(new Set(receipts.map((receipt) => receipt.userEntryId)).size).toBe(2);
  const receiptUsers = receipts.map((receipt) =>
    f.manager.getBranch().find((entry) => entry.id === receipt.userEntryId),
  );
  expect(
    receiptUsers.every(
      (entry) =>
        entry?.type === 'message' &&
        entry.message.role === 'user' &&
        JSON.stringify(entry.message.content).includes('/quit'),
    ),
  ).toBe(true);
  expect(f.errors).toEqual([]);
});

it('admits the fake native callback as one SDK steer entry with terminal identity', async () => {
  const f = await fixture(undefined, false, false, true);
  const turn = f.session.prompt('Start the tool.');
  await vi.waitFor(() => expect(f.toolStarted).toHaveBeenCalledOnce());
  const sessionId = f.manager.getSessionId();
  const store = new QueueDraftStore();
  store.setSession(sessionId);
  store.add({ clientId: 'native-head', mode: 'steer', text: 'native input' });
  const nativeSteer = vi.fn(
    async (_text: string, accepted: () => void | Promise<void>) => {
      await accepted();
      return { status: 'accepted' as const, steerId: 'steer-1' };
    },
  );
  registerNativeSteeringController(sessionId, {
    isAvailable: () => true,
    steer: nativeSteer,
    close: () => undefined,
  });
  const host = {
    getContext: () => f.ctx,
    pi: f.pi,
    store,
    isCurrent: (ctx: ExtensionContext) => ctx === f.ctx,
    publish: vi.fn(),
  };
  const handler =
    nativeSteeringContribution(host).actionHandlers?.[
      QUEUE_STEER_NOW_ACTION_ID
    ];
  if (!handler) throw new Error('Native steering handler is missing.');
  await expect(
    handler(
      {
        actionId: QUEUE_STEER_NOW_ACTION_ID,
        input: {
          clientId: 'native-head',
          revision: 1,
          expectedSessionId: sessionId,
        },
      } as never,
      {} as never,
    ),
  ).resolves.toMatchObject({ accepted: true });
  expect(nativeSteer).toHaveBeenCalledWith(
    'native input',
    expect.any(Function),
  );
  expect(store.listHandoffs()).toMatchObject([
    { clientId: 'native-head', status: 'accepted' },
  ]);
  expect(f.contexts).toHaveLength(1);
  f.releaseTool();
  await turn;
  await f.session.waitForIdle();
  expect(
    f.contexts
      .at(-1)
      ?.messages.filter(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('native input'),
      ),
  ).toHaveLength(1);
  await vi.waitFor(() =>
    expect(store.listHandoffs()).toMatchObject([
      { clientId: 'native-head', status: 'entered' },
    ]),
  );
});

it('queues follow-up before source creation, holds it across SDK idle, and releases only after logical closure', async () => {
  const f = await fixture(
    (api) => {
      api.on('tool_execution_end', (_event, ctx) => {
        getScopedServices(
          ctx.sessionManager.getSessionId(),
        ).requestDependencies?.register('process', 'hung-task', ctx);
      });
    },
    false,
    false,
    true,
  );
  const run = f.session.prompt('Start the blocked tool.');
  await vi.waitFor(() => expect(f.toolStarted).toHaveBeenCalledOnce());
  expect(await f.session.followUp('next request')).toBe('queued');
  expect(f.session.getFollowUpMessages()).toEqual(['next request']);
  f.releaseTool();
  await run;
  await f.session.waitForIdle();
  expect(f.contexts).toHaveLength(2);
  expect(f.session.getFollowUpMessages()).toEqual(['next request']);
  await expect(f.dispatch('new-prompt', 'not admitted')).rejects.toMatchObject({
    code: 'busy',
  });
  f.complete('hung-task');
  await vi.waitFor(() => expect(f.contexts).toHaveLength(4));
  await f.session.waitForIdle();
  const users = f.manager
    .getBranch()
    .filter(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    );
  const markers = f.manager
    .getBranch()
    .filter(
      (entry) =>
        entry.type === 'custom' && entry.customType === 'response-closure',
    );
  expect(users).toHaveLength(2);
  expect(markers).toHaveLength(2);
  expect(f.session.getFollowUpMessages()).toEqual([]);
  expect(f.errors).toEqual([]);
});

it('tree navigation cancels held user follow-ups from the previous branch', async () => {
  const f = await fixture(
    (api) => {
      api.on('tool_execution_start', (_event, ctx) => {
        getScopedServices(
          ctx.sessionManager.getSessionId(),
        ).requestDependencies?.register('process', 'branch-task', ctx);
      });
    },
    false,
    false,
    true,
  );
  const run = f.session.prompt('branch work');
  await vi.waitFor(() => expect(f.toolStarted).toHaveBeenCalledOnce());
  await f.followUp('old-branch-input', 'do not run on another branch');
  f.releaseTool();
  await run;
  expect(f.session.getFollowUpMessages()).toHaveLength(1);
  const user = f.manager
    .getBranch()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user');
  if (!user) throw new Error('missing branch user');
  await f.session.navigateTree(user.id);
  expect(f.session.getFollowUpMessages()).toEqual([]);
  expect(f.register('unowned-source')).toBe(false);
  expect(f.contexts).toHaveLength(2);
});

it('idle abort abandons the owner and a late result cannot manufacture closure', async () => {
  const f = await fixture(
    (api) => {
      api.on('tool_execution_start', (_event, ctx) => {
        getScopedServices(
          ctx.sessionManager.getSessionId(),
        ).requestDependencies?.register('process', 'aborted-task', ctx);
      });
    },
    false,
    false,
    true,
  );
  const run = f.session.prompt('start work');
  await vi.waitFor(() => expect(f.toolStarted).toHaveBeenCalledOnce());
  f.releaseTool();
  await run;
  expect(
    getScopedServices(f.manager.getSessionId()).requestDependencies?.isOpen?.(),
  ).toBe(true);
  await f.abort();
  expect(
    getScopedServices(f.manager.getSessionId()).requestDependencies?.isOpen?.(),
  ).toBe(false);
  f.complete('aborted-task');
  await vi.waitFor(() => expect(f.contexts).toHaveLength(3));
  await f.session.waitForIdle();
  expect(
    f.manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === 'custom' && entry.customType === 'response-closure',
      ),
  ).toEqual([]);
  const restored = new RequestClosureLifecycle();
  restored.restore({
    sessionManager: f.manager,
  } as unknown as ExtensionContext);
  expect(
    restored.isOpen({
      sessionManager: f.manager,
    } as unknown as ExtensionContext),
  ).toBe(false);
});

it.each([
  false,
  true,
])('idle waiting steering resumes the original request, external=%s', async (external) => {
  const f = await fixture(
    (api) => {
      api.on('tool_execution_start', (_event, ctx) => {
        getScopedServices(
          ctx.sessionManager.getSessionId(),
        ).requestDependencies?.register('process', 'hung-task', ctx);
      });
    },
    false,
    false,
    true,
  );
  const run = f.session.prompt('Start work.');
  await vi.waitFor(() => expect(f.toolStarted).toHaveBeenCalledOnce());
  f.releaseTool();
  await run;
  const originalUser = f.manager
    .getBranch()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user');
  expect(
    await (external
      ? f.steer('idle-steer', 'stop hung work')
      : f.nativeSteer('idle-steer', 'stop hung work')),
  ).toMatchObject({ accepted: true });
  await vi.waitFor(() => expect(f.contexts).toHaveLength(3));
  await f.session.waitForIdle();
  const steeringUsers = f.manager
    .getBranch()
    .filter(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    );
  expect(
    f.manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === 'custom' && entry.customType === 'steering-message',
      ),
  ).toMatchObject([{ data: { userEntryId: steeringUsers[1]?.id } }]);
  expect(f.register('second-task')).toBe(true);
  const restored = new RequestClosureLifecycle();
  restored.restore({
    sessionManager: f.manager,
  } as unknown as ExtensionContext);
  expect(
    restored.hasPendingWait({
      sessionManager: f.manager,
    } as unknown as ExtensionContext),
  ).toBe(true);
  f.complete('hung-task');
  await vi.waitFor(() => expect(f.contexts).toHaveLength(4));
  await f.session.waitForIdle();
  f.complete('second-task');
  await vi.waitFor(() => expect(f.contexts).toHaveLength(5));
  await f.session.waitForIdle();
  const marker = f.manager
    .getBranch()
    .find(
      (entry) =>
        entry.type === 'custom' && entry.customType === 'response-closure',
    );
  expect(marker).toMatchObject({
    data: { requestMessageId: originalUser?.id },
  });
  if (external)
    expect(
      f.manager
        .getBranch()
        .flatMap((entry) => externalDeliveryReceipt(entry) ?? []),
    ).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

it('rejects a native fork or replaced session without dispatching', async () => {
  const f = await fixture();
  await f.send('initial', 'Initial input');
  const anchor = f.manager.getLeafId();
  if (!anchor) throw new Error('Missing native branch anchor.');
  const firstUser = f.manager
    .getBranch()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user');
  if (!firstUser) throw new Error('Missing fixture user.');
  f.manager.branch(firstUser.id);
  await expect(
    f.dispatch('forked-prompt', 'Answer', f.manager.getSessionId(), anchor),
  ).rejects.toMatchObject({ code: 'orchestration-conflict' });
  await expect(
    f.steer('forked-reply', 'Answer', f.manager.getSessionId(), anchor),
  ).rejects.toMatchObject({ code: 'orchestration-conflict' });
  const originalSessionId = f.manager.getSessionId();
  f.manager.newSession();
  await expect(
    f.steer('replaced-reply', 'Answer', originalSessionId, firstUser.id),
  ).rejects.toMatchObject({ code: 'orchestration-conflict' });
  expect(f.contexts).toHaveLength(1);
});

it('binds identical native users durably, keeps provider context clean and preserves literal commands and images', async () => {
  const command = vi.fn();
  const f = await fixture((api) => {
    api.registerCommand('fixture-command', {
      description: 'Fixture command',
      handler: command,
    });
  });
  const texts = [
    'да',
    'да',
    ' /quit\n',
    '/fixture-command',
    '/skill:fixture $fixture',
  ];
  for (const [index, text] of texts.entries())
    await f.send(`fixture-correlation-${index}`, text);
  const image = join(f.root, 'image.png');
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  await writeFile(image, bytes);
  await f.send('fixture-correlation-image', 'image', [
    { type: 'image', path: image, mediaType: 'image/png' },
  ]);
  expect(command).not.toHaveBeenCalled();
  expect(f.errors).toEqual([]);
  const sessionFile = f.manager.getSessionFile();
  if (!sessionFile) throw new Error('Fixture session file is missing.');
  const disk = await readFile(sessionFile, 'utf8');
  const entries = disk
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const receipts = entries.flatMap(
    (entry) => externalDeliveryReceipt(entry) ?? [],
  );
  expect(receipts).toHaveLength(6);
  expect(new Set(receipts.map((receipt) => receipt.userEntryId)).size).toBe(6);
  expect(
    receipts.map(
      (receipt) =>
        entries.find((entry) => entry.id === receipt.userEntryId).message
          .content[0].text,
    ),
  ).toEqual([...texts, 'image']);
  const last = f.contexts.at(-1);
  if (!last) throw new Error('Fixture context is missing.');
  expect(
    last.messages.filter((message) => message.role === 'user').at(-1),
  ).toMatchObject({
    content: [
      { type: 'text', text: 'image' },
      { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
    ],
  });
  expect(JSON.stringify(f.contexts)).not.toContain('fixture-correlation-');
  expect(JSON.stringify(f.contexts)).not.toContain('PI_EXTERNAL_DELIVERY');
  const reopened = SessionManager.open(sessionFile);
  expect(
    reopened
      .getEntries()
      .flatMap((entry) => externalDeliveryReceipt(entry) ?? []),
  ).toEqual(receipts);
  expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain(
    'fixture-correlation-',
  );
  await expect(f.dispatch('fixture-correlation-0', 'да')).rejects.toThrow(
    'already has a persisted receipt',
  );
});

it('records the native entry when default image normalization augments its text', async () => {
  const f = await fixture(undefined, false, null);
  const image = join(f.root, 'image-defaults.png');
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  await writeFile(image, bytes);

  await f.send('fixture-correlation-default-image', 'image', [
    { type: 'image', path: image, mediaType: 'image/png' },
  ]);

  const userEntry = f.manager
    .getEntries()
    .find(
      (entry) =>
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some(
          (part) =>
            part.type === 'text' &&
            part.text.startsWith('image\n\n[Image omitted:'),
        ),
    );
  expect(userEntry).toBeDefined();
  if (
    userEntry?.type !== 'message' ||
    userEntry.message.role !== 'user' ||
    !Array.isArray(userEntry.message.content)
  )
    throw new Error('missing user entry');
  const receipts = f.manager
    .getEntries()
    .flatMap((entry) => externalDeliveryReceipt(entry) ?? []);
  expect(receipts).toEqual([
    {
      version: 1,
      deliveryId: 'fixture-correlation-default-image',
      userEntryId: userEntry.id,
    },
  ]);
  const providerUser = f.contexts
    .at(-1)
    ?.messages.filter((message) => message.role === 'user')
    .at(-1);
  expect(providerUser).toMatchObject({
    content: [
      {
        type: 'text',
        text: expect.stringContaining(
          '[Image omitted: could not be resized below the inline image size limit.]',
        ),
      },
    ],
  });
  expect(userEntry.message.content[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining(
      '[Image omitted: could not be resized below the inline image size limit.]',
    ),
  });
  expect(JSON.stringify(f.contexts)).not.toContain(
    'fixture-correlation-default-image',
  );
  expect(JSON.stringify(f.contexts)).not.toContain('PI_EXTERNAL_DELIVERY');
});

it('rejects an answer addressed to another native session before executing a turn', async () => {
  const f = await fixture();
  await expect(
    f.dispatch('wrong-session-answer', 'yes', 'another-session'),
  ).rejects.toThrow('source session has been replaced');
  expect(f.contexts).toHaveLength(0);
  await f.dispatch('correct-session-answer', 'yes', f.manager.getSessionId());
  await vi.waitFor(() => expect(f.contexts).toHaveLength(1));
  await f.session.waitForIdle();
  expect(
    f.manager
      .getEntries()
      .flatMap((entry) => externalDeliveryReceipt(entry) ?? []),
  ).toHaveLength(1);
});

it('does not bind an identical intervening browser message while external preflight is suspended', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture((api) => {
    api.on('input', async (event) => {
      if (event.source === 'extension') {
        entered();
        await gate;
      }
      return { action: 'continue' };
    });
  });
  await f.dispatch('fixture-correlation-race', 'да');
  await started;
  await f.session.prompt('да');
  expect(
    f.manager
      .getEntries()
      .flatMap((entry) => externalDeliveryReceipt(entry) ?? []),
  ).toEqual([]);
  release();
  await vi.waitFor(() => expect(f.contexts).toHaveLength(2));
  await f.session.waitForIdle();
  const users = f.manager
    .getEntries()
    .filter(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    );
  const receipts = f.manager
    .getEntries()
    .flatMap((entry) => externalDeliveryReceipt(entry) ?? []);
  expect(users).toHaveLength(2);
  expect(receipts).toEqual([
    {
      version: 1,
      deliveryId: 'fixture-correlation-race',
      userEntryId: users[1].id,
    },
  ]);
  expect(f.errors).toEqual([]);
});

it.each([
  true,
  false,
])('uses only native identity with a replacing hook (before=%s)', async (before) => {
  const f = await fixture((api) => {
    api.on('message_end', (event) =>
      event.message.role === 'user'
        ? { message: structuredClone(event.message) }
        : undefined,
    );
  }, before);
  await f.send('fixture-correlation-replaced', 'да');
  // SDK applies replacements in-place to the original native object. A hook
  // before ours exposes an intermediate clone: never fall back to its text.
  const receipts = f.manager
    .getEntries()
    .flatMap((entry) => externalDeliveryReceipt(entry) ?? []);
  expect(receipts).toHaveLength(before ? 0 : 1);
  if (!before)
    expect(receipts[0].userEntryId).toBe(
      f.manager
        .getEntries()
        .find(
          (entry) => entry.type === 'message' && entry.message.role === 'user',
        )?.id,
    );
  expect(f.contexts).toHaveLength(1);
  expect(f.errors).toEqual([]);
});
