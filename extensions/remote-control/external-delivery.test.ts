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
import { afterEach, expect, it, vi } from 'vitest';
import { dispatchDashboardCommand } from './command-dispatcher';
import { installExternalDeliveryReceipts } from './external-delivery';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  extra?: ExtensionFactory,
  before = false,
  imageAutoResize: boolean | null = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'native-delivery-sdk-'));
  let session: AgentSession | undefined;
  cleanups.push(async () => {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  });
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
          reason: 'stop',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'fixture answer' }],
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
            stopReason: 'stop',
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
  const core: ExtensionFactory = (api) => {
    pi = api;
    installExternalDeliveryReceipts(api);
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
    noTools: 'all',
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
    manager,
    contexts,
    errors,
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
    dispatch(deliveryId: string, text: string, expectedSessionId?: string) {
      return dispatchDashboardCommand(pi, ctx, {
        id: deliveryId,
        type: 'prompt',
        externalDeliveryId: deliveryId,
        text,
        ...(expectedSessionId ? { expectedSessionId } : {}),
      });
    },
  };
}

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
  const disk = await readFile(f.manager.getSessionFile()!, 'utf8');
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
  const last = f.contexts.at(-1)!;
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
  const reopened = SessionManager.open(f.manager.getSessionFile()!);
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
