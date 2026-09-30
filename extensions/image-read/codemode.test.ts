import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { PhotonImage } from '@silvia-odwyer/photon-node';
import { expect, it } from 'vitest';
import codemode from '../codemode';
import { createTaskStore, reconstruct } from '../tasks/store';
import { registerTodoTool } from '../tasks/tool';
import imageRead from './index';

it('loads the local wrapper once while the builtin is disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-codemode-loader-'));
  try {
    const rootSettings = JSON.parse(
      await readFile(resolve('settings.json'), 'utf8'),
    ) as {
      extensions?: string[];
      defaultTools?: string[];
      codemode?: { mode?: string };
    };
    expect(rootSettings.extensions).toContain('-builtin:codemode');
    expect(rootSettings.defaultTools).toContain('+codemode');
    expect(rootSettings.codemode?.mode).toBe('on');

    const local = join(root, 'extensions', 'codemode', 'index.ts');
    await mkdir(dirname(local), { recursive: true });
    await symlink(resolve('extensions/codemode/index.ts'), local);
    await symlink(
      resolve('extensions/shared'),
      join(root, 'extensions', 'shared'),
    );
    await symlink(resolve('node_modules'), join(root, 'node_modules'));
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        extensions: ['-builtin:codemode'],
        defaultTools: ['+codemode'],
        codemode: { mode: 'on' },
      }),
    );
    const settings = SettingsManager.create(root, root);
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: settings,
      additionalExtensionPaths: [local],
      extensionFactories: [
        {
          name: 'codemode',
          factory: createCodemodeExtension(),
          builtin: true,
          replaceable: true,
        },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    expect(result.warnings ?? []).toEqual([]);
    expect(
      result.extensions.filter((extension) => extension.path === local),
    ).toHaveLength(1);
    const codemode = result.extensions.filter((extension) =>
      extension.tools.has('codemode'),
    );
    expect(codemode).toHaveLength(1);
    expect(codemode[0]?.path).toBe(local);
    expect(codemode[0]?.tools.get('codemode')?.definition.defaultActive).toBe(
      false,
    );
    expect(
      JSON.stringify(codemode[0]?.tools.get('codemode')?.definition),
    ).not.toContain('models');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { path: 'image.png', mode: 'on' as const },
  { path: 'missing.png', mode: 'on' as const },
  { path: 'image.png', mode: 'only' as const },
  { path: 'missing.png', mode: 'only' as const },
])('composes read $path and durable todo mutations in codemode mode $mode', async ({
  path,
  mode,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-codemode-sdk-'));
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>['session']
    | undefined;
  try {
    const image = new PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
    try {
      await writeFile(join(root, 'image.png'), Buffer.from(image.get_bytes()));
    } finally {
      image.free();
    }
    const runtime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(root, 'models.sqlite'),
      refreshOnCreate: false,
    });
    const contexts: TranscriptContext[] = [];
    const failedRead = path === 'missing.png';
    const code = `if ('write' in tools) throw new Error('Unexpected write capability'); if (typeof models !== 'undefined') throw new Error('Unexpected models API'); const declaration = await describeTool('read'); const matches = await searchTools('read image file', {limit: 5}); if (!declaration || !matches.some(tool => tool.name === 'read')) throw new Error('Tool discovery failed'); const tasks = await tools.todo_update({changes: [{id: "T1", text: "Verify images"}]}); const result = await tools.read({path: ${JSON.stringify(path)}}); text(result.text); for (const block of result.images) image(block); text({ids: tasks.ids});`;
    runtime.registerProvider('fixture', {
      api: 'openai-completions',
      baseUrl: 'http://fixture.invalid',
      apiKey: 'fixture',
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
        const first = contexts.length === 1;
        const stream = new AssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({
            type: 'done',
            reason: first ? 'toolUse' : 'stop',
            message: {
              role: 'assistant',
              content: first
                ? [
                    {
                      type: 'toolCall',
                      id: 'compose',
                      name: 'codemode',
                      arguments: { code },
                    },
                  ]
                : [{ type: 'text', text: 'Done' }],
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
              stopReason: first ? 'toolUse' : 'stop',
              timestamp: Date.now(),
            },
          });
          stream.end();
        });
        return stream;
      },
    });
    const settings = SettingsManager.inMemory({
      codemode: { mode },
      compaction: { enabled: false },
      retry: { enabled: false },
      images: { autoResize: false },
    });
    const store = createTaskStore();
    const hooks: Array<{ toolName: string; parentToolCallId?: string }> = [];
    const errors: unknown[] = [];
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: settings,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        codemode,
        (pi) => {
          imageRead(pi);
          registerTodoTool(pi, store);
          pi.on('tool_call', (event) => {
            hooks.push({
              toolName: event.toolName,
              parentToolCallId: event.parentToolCallId,
            });
          });
        },
      ],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(root);
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model: runtime.getModel('fixture', 'fixture'),
      settingsManager: settings,
      sessionManager: manager,
      resourceLoader: loader,
      tools: ['read', 'todo_update', 'codemode'],
    }));
    await session.bindExtensions({
      mode: 'rpc',
      onError: (error) => errors.push(error),
    });
    await session.prompt('Verify codemode');
    expect(errors).toEqual([]);
    expect(
      getCurrentTools(contexts[0].messages).map((tool) => tool.name),
    ).toEqual(
      mode === 'on' ? ['read', 'todo_update', 'codemode'] : ['codemode'],
    );
    const codemodeDefinition = getCurrentTools(contexts[0].messages).find(
      (tool) => tool.name === 'codemode',
    );
    expect(JSON.stringify(codemodeDefinition)).not.toContain('models');
    expect(hooks).toEqual([
      { toolName: 'codemode', parentToolCallId: undefined },
      { toolName: 'todo_update', parentToolCallId: 'compose' },
      { toolName: 'read', parentToolCallId: 'compose' },
    ]);
    const results = manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === 'message' && entry.message.role === 'toolResult',
      );
    expect(results).toHaveLength(1);
    const parent = results[0];
    if (parent?.type !== 'message' || parent.message.role !== 'toolResult')
      throw new Error('Missing parent result');
    expect(parent.message.isError).toBe(failedRead);
    expect(parent.message.nestedCalls?.calls).toMatchObject([
      { id: 'compose/1', name: 'todo_update', status: 'ok' },
      { id: 'compose/2', name: 'read', status: failedRead ? 'error' : 'ok' },
    ]);
    const forwarded = contexts[1]?.messages.find(
      (message) => message.role === 'toolResult',
    );
    if (failedRead) {
      expect(parent.message.nestedCalls?.calls[1]?.error).toContain(
        'missing.png',
      );
      expect(forwarded?.content).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
      );
    } else {
      expect(forwarded?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
        ]),
      );
    }
    const restored = createTaskStore();
    reconstruct(restored, { sessionManager: manager } as never);
    expect(restored.state.tasks).toMatchObject([
      { id: 'T1', text: 'Verify images' },
    ]);
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
