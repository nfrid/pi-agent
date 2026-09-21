import { createHash } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ExternalDeliveryCommand,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetadataStore } from '../metadata.js';
import { type DashboardRouteContext, dashboardRoutes } from '../routes.js';
import { SessionIndex } from '../session-index.js';
import { ExternalDeliveryService } from './external-delivery-service.js';
import { bindAndDeliverPrompt } from './orchestration/runtime-binding.js';
import { OrchestrationService } from './orchestration-service.js';
import { RuntimeService } from './runtime-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('settles only an idle external conversation, resumes old replies and never replays a completed close', async () => {
  const f = await fixture('retire-topic');
  const command = { commandId: 'close-1', conversationRef: 'retire-topic' };
  await f.service.submit('p', {
    deliveryId: 'work',
    conversationRef: 'retire-topic',
    text: 'work',
  });
  await expect(
    f.service.settleConversation('p', command),
  ).rejects.toMatchObject({ code: 'busy' });
  expect(f.stop).not.toHaveBeenCalled();
  await f.finish();
  await f.service.get('p', 'work');
  f.live.liveState = 'working';
  await expect(
    f.service.settleConversation('p', command),
  ).rejects.toMatchObject({ code: 'busy' });
  expect(f.stop).not.toHaveBeenCalled();
  f.live.liveState = 'idle';
  expect(await f.service.settleConversation('p', command)).toEqual({
    state: 'settled',
    threadId: f.thread.id,
  });
  expect(f.repository.getThread(f.thread.id)?.settledAt).toBeDefined();
  expect(f.stop).toHaveBeenCalledWith('runtime', false, true);
  await f.reopen();
  await f.service.submit('p', {
    deliveryId: 'reply-old',
    threadId: f.thread.id,
    text: 'continue old topic',
  });
  expect(f.resume).toHaveBeenCalledOnce();
  expect(f.repository.getThread(f.thread.id)?.settledAt).toBeUndefined();
  expect((await f.service.settleConversation('p', command)).state).toBe(
    'settled',
  );
  expect(f.stop).toHaveBeenCalledTimes(1);
  await expect(
    f.service.settleConversation('p', {
      ...command,
      conversationRef: 'another',
    }),
  ).rejects.toMatchObject({ code: 'idempotency-conflict' });
  expect(
    await f.service.settleConversation('p', {
      commandId: 'empty',
      conversationRef: 'not-created',
    }),
  ).toEqual({ state: 'absent' });
});

it('uses an explicit initial model and rejects unavailable selections without consuming delivery IDs', async () => {
  const f = await fixture();
  f.repository.transitionRun(f.run.id, 'completed');
  const command = {
    deliveryId: 'model-choice',
    conversationRef: 'fresh-model',
    text: 'Hello',
    model: { provider: 'fixture', model: 'small', thinking: 'medium' },
  };
  await expect(
    f.service.submit('p', {
      ...command,
      model: { ...command.model, thinking: 'max' },
    }),
  ).rejects.toThrow('unavailable');
  expect(
    f.repository.getCommandIntent(f.intentKey(command.deliveryId)),
  ).toBeUndefined();
  const result = await f.service.submit('p', command);
  expect(result.state).toBe('pending');
  expect(f.send).not.toHaveBeenCalled();
  expect(f.repository.listRuns(result.threadId ?? '')[0]?.model).toEqual(
    command.model,
  );
  await expect(
    f.service.submit('p', {
      ...command,
      model: { ...command.model, thinking: 'low' },
    }),
  ).rejects.toMatchObject({ code: 'idempotency-conflict' });
  await f.reopen();
  expect((await f.service.submit('p', command)).threadId).toBe(result.threadId);
});

async function fixture(conversationRef?: string) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'external-delivery-sqlite-'),
  );
  const database = path.join(root, 'state', 'dashboard.sqlite');
  const sessionRoot = path.join(root, 'sessions');
  await mkdir(sessionRoot);
  const file = path.join(sessionRoot, 'session.jsonl');
  await writeFile(
    file,
    `${JSON.stringify({ type: 'session', version: 3, id: 'session', cwd: root, timestamp: new Date().toISOString() })}\n`,
  );
  let metadata = new MetadataStore(database);
  const sessions = new SessionIndex(sessionRoot);
  let live: RuntimeSnapshot = {
    runtimeId: 'runtime',
    pid: 1,
    ownership: 'managed',
    cwd: root,
    liveState: 'waiting',
    online: true,
    session: { id: 'session', leafId: 'base', entries: [] },
  };
  let sequence = 0;
  let persistedLeaf: string | null = null;
  async function append(
    role: string,
    content: unknown,
    options: {
      id?: string;
      parentId?: string | null;
      stopReason?: string;
    } = {},
  ) {
    const id = options.id ?? `entry-${++sequence}`;
    await appendFile(
      file,
      `${JSON.stringify({ type: 'message', id, parentId: options.parentId === undefined ? persistedLeaf : options.parentId, message: { role, content, ...(options.stopReason ? { stopReason: options.stopReason } : {}) } })}\n`,
    );
    persistedLeaf = id;
    live.session.leafId = id;
    await sessions.rebuild();
    return id;
  }
  await append('user', 'prior user', { id: 'before-base' });
  await append('assistant', [{ type: 'text', text: 'prior answer' }], {
    id: 'base',
    stopReason: 'stop',
  });
  const project = metadata.orchestration.createProject({
    id: 'p',
    title: 'Project',
    rootPath: root,
    defaultIsolation: 'main',
  });
  const checkout = metadata.orchestration.createCheckout({
    id: 'checkout',
    projectId: project.id,
    kind: 'main',
    path: root,
    status: 'ready',
  });
  const thread = metadata.orchestration.createThread({
    id: 'thread',
    projectId: project.id,
    title: 'Thread',
    ...(conversationRef
      ? {
          externalRef: `external-delivery:${createHash('sha256').update(`p\0${conversationRef}`).digest('hex')}`,
        }
      : {}),
    checkoutId: checkout.id,
  });
  const run = metadata.orchestration.createRun({
    id: 'run',
    threadId: thread.id,
    checkoutId: checkout.id,
    initialPrompt: 'prior user',
    status: 'waiting',
    runtimeId: 'runtime',
    piSessionId: 'session',
  });
  const registry = {
    sendCommand: async (runtimeId: string, input: { text: string }) =>
      send(runtimeId, input),
    get: (id: string) => (id === live.runtimeId ? live : undefined),
    snapshots: () => [live],
  };
  const send = vi.fn(async (_runtimeId: string, command: { text: string }) => {
    await append('user', command.text);
    live.liveState = 'working';
    return { accepted: true };
  });
  const artifacts = path.join(root, 'artifacts');
  const launch = vi.fn(async (_input: unknown) => {
    live = {
      ...live,
      runtimeId: 'resumed',
      online: true,
      liveState: 'waiting',
    };
    return { runtimeId: live.runtimeId };
  });
  const resume = vi.fn(
    async (input: {
      commandId: string;
      projectId: string;
      checkoutId: string;
      sessionId: string;
    }) => {
      const runtime = new RuntimeService(
        registry as never,
        {
          prepareLaunch: async () => ({
            runtimeId: 'resumed',
            projectId: input.projectId,
            checkoutId: input.checkoutId,
            sessionFile: file,
            cwd: root,
          }),
          launch,
        } as never,
        sessions,
        metadata.orchestration,
      );
      return (await runtime.startWithReceipt(input)).result.runtimeId;
    },
  );
  const stop = vi.fn(
    async (_runtimeId: string, _force: boolean, onlyIfIdle: boolean) => {
      if (onlyIfIdle && !['waiting', 'idle'].includes(live.liveState))
        throw Object.assign(new Error('busy'), { code: 'busy' });
      live.online = false;
    },
  );
  const make = () =>
    new ExternalDeliveryService(
      metadata.orchestration,
      new OrchestrationService({
        repository: metadata.orchestration,
        registry: registry as never,
        manager: { stop } as never,
      }),
      registry as never,
      sessions,
      artifacts,
      send,
      resume,
      undefined,
      async () => [
        {
          provider: 'fixture',
          model: 'small',
          name: 'Small',
          thinkingLevels: ['medium'],
        },
      ],
    );
  let service = make();
  const value = {
    root,
    file,
    sessions,
    project,
    thread,
    run,
    send,
    resume,
    stop,
    launch,
    registry,
    artifacts,
    append,
    async resetSession() {
      persistedLeaf = null;
      live.session.leafId = undefined;
      await writeFile(
        file,
        `${JSON.stringify({ type: 'session', version: 3, id: 'session', cwd: root })}\n`,
      );
      await sessions.rebuild();
    },
    orchestration() {
      return new OrchestrationService({
        repository: metadata.orchestration,
        registry: registry as never,
        manager: {} as never,
      });
    },
    intentKey(deliveryId: string) {
      return `external-delivery:${createHash('sha256').update(`p\0${deliveryId}`).digest('hex')}`;
    },
    get repository() {
      return metadata.orchestration;
    },
    get service() {
      return service;
    },
    get live() {
      return live;
    },
    set live(next: RuntimeSnapshot) {
      live = next;
    },
    async reopen() {
      metadata.close();
      metadata = new MetadataStore(database);
      service = make();
    },
    async finish(text = 'answer') {
      await append(
        'assistant',
        [
          { type: 'text', text: 'tool commentary must not leak' },
          { type: 'toolCall', id: 'tool', name: 'read', arguments: {} },
        ],
        { stopReason: 'toolUse' },
      );
      await append('toolResult', 'tool output');
      const id = await append(
        'assistant',
        [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text },
        ],
        { stopReason: 'stop' },
      );
      live.liveState = 'waiting';
      return id;
    },
  };
  cleanups.push(async () => {
    await sessions.close();
    metadata.close();
    await rm(root, { recursive: true, force: true });
  });
  return value;
}
const command = (deliveryId: string, text = 'да'): ExternalDeliveryCommand => ({
  deliveryId,
  threadId: 'thread',
  text,
});

describe('external delivery with SQLite and persisted Pi branches', () => {
  it('completes second and third identical user texts as distinct appended turns and freezes replies across reopen', async () => {
    const f = await fixture();
    for (const id of ['first', 'second', 'third']) {
      await expect(f.service.submit('p', command(id))).resolves.toMatchObject({
        state: 'running',
      });
      const messageId = await f.finish(`reply-${id}`);
      await expect(f.service.get('p', id)).resolves.toEqual({
        deliveryId: id,
        threadId: 'thread',
        state: 'completed',
        reply: { text: `reply-${id}`, messageId },
      });
    }
    expect(new Set(f.send.mock.calls.map(([, sent]) => sent.text)).size).toBe(
      3,
    );
    await f.reopen();
    await expect(f.service.get('p', 'first')).resolves.toMatchObject({
      reply: { text: 'reply-first' },
    });
    await expect(
      f.service.submit('p', command('first')),
    ).resolves.toMatchObject({ reply: { text: 'reply-first' } });
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it('scopes identical client IDs and conversation refs to the path project', async () => {
    const f = await fixture();
    f.repository.transitionRun('run', 'completed');
    f.repository.createProject({
      id: 'other',
      title: 'Other',
      rootPath: path.join(f.root, 'other'),
      defaultIsolation: 'main',
    });
    f.repository.createCheckout({
      id: 'other-checkout',
      projectId: 'other',
      kind: 'main',
      path: path.join(f.root, 'other'),
      status: 'ready',
    });
    const input = {
      deliveryId: 'same',
      conversationRef: 'same-chat',
      text: 'да',
    };
    const first = await f.service.submit('p', input);
    const second = await f.service.submit('other', input);
    expect(first.threadId).not.toBe(second.threadId);
    expect(f.repository.getThread(first.threadId as string)?.projectId).toBe(
      'p',
    );
    expect(f.repository.getThread(second.threadId as string)?.projectId).toBe(
      'other',
    );
    await expect(f.service.get('other', 'same')).resolves.toMatchObject({
      threadId: second.threadId,
    });
    await expect(f.service.submit('p', input)).resolves.toMatchObject({
      threadId: first.threadId,
    });
  });

  it('rejects concurrent changed payload before sharing a promise', async () => {
    const f = await fixture();
    const first = f.service.submit('p', command('id'));
    await expect(
      f.service.submit('p', command('id', 'different')),
    ).rejects.toMatchObject({ code: 'idempotency-conflict' });
    await first;
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('does not consume a busy delivery ID or write artifacts', async () => {
    const f = await fixture();
    f.live.liveState = 'working';
    await expect(
      f.service.submit('p', {
        ...command('busy'),
        attachments: [{ name: 'a', mimeType: 'text/plain', data: 'YQ==' }],
      }),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(f.repository.pendingCommandIntents()).toEqual([]);
    await expect(readdir(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(f.service.get('p', 'busy')).rejects.toMatchObject({
      code: 'unknown-workspace',
    });
    f.live.liveState = 'waiting';
    await expect(
      f.service.submit('p', command('busy', 'new payload')),
    ).resolves.toMatchObject({ state: 'running' });
  });

  it('releases only definitely unsent busy reservations and owned artifacts', async () => {
    const f = await fixture();
    f.send.mockRejectedValueOnce(
      Object.assign(new Error('busy before acceptance'), { code: 'busy' }),
    );
    const input = {
      ...command('busy-at-runtime'),
      attachments: [{ name: 'a', mimeType: 'text/plain', data: 'YQ==' }],
    };
    await expect(f.service.submit('p', input)).rejects.toMatchObject({
      code: 'busy',
    });
    expect(
      f.repository.getCommandIntent(f.intentKey('busy-at-runtime')),
    ).toBeUndefined();
    const [dir] = await readdir(f.artifacts);
    expect(await readdir(path.join(f.artifacts, dir))).toEqual([]);
    await expect(
      f.service.submit('p', command('busy-at-runtime', 'changed while unsent')),
    ).resolves.toMatchObject({ state: 'running' });
  });

  it.each([
    'aborted',
    'length',
    'error',
  ])('never completes a final with stopReason %s', async (stopReason) => {
    const f = await fixture();
    await f.service.submit('p', command('bad-final'));
    await f.append('assistant', [{ type: 'text', text: 'incomplete text' }], {
      stopReason,
    });
    f.live.liveState = 'waiting';
    await expect(f.service.get('p', 'bad-final')).resolves.toMatchObject({
      state: 'attention',
      error: { code: 'incomplete-reply' },
    });
  });

  it('requires live settlement rather than an old waiting run and rejects oversized replies without truncation', async () => {
    const f = await fixture();
    await f.service.submit('p', command('settlement'));
    await f.append('assistant', [{ type: 'text', text: 'not settled yet' }], {
      stopReason: 'stop',
    });
    await expect(f.service.get('p', 'settlement')).resolves.toMatchObject({
      state: 'running',
    });
    f.live.liveState = 'waiting';
    await expect(f.service.get('p', 'settlement')).resolves.toMatchObject({
      state: 'completed',
    });
    await f.service.submit('p', command('large-reply'));
    await f.finish('x'.repeat(256 * 1024 + 1));
    await expect(f.service.get('p', 'large-reply')).resolves.toMatchObject({
      state: 'attention',
      error: { code: 'reply-too-large' },
    });
  });

  it('holds admission while registry still reports old waiting state', async () => {
    const f = await fixture();
    f.send.mockImplementationOnce(async () => ({ accepted: true }));
    await f.service.submit('p', command('one'));
    await expect(f.service.submit('p', command('two'))).rejects.toMatchObject({
      code: 'busy',
    });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('keeps missing user/final and stale-index data pending, then completes', async () => {
    const f = await fixture();
    f.send.mockImplementationOnce(async () => ({ accepted: true }));
    await expect(f.service.submit('p', command('lag'))).resolves.toMatchObject({
      state: 'pending',
    });
    const sent = f.send.mock.calls[0][1].text;
    f.live.session.leafId = 'not-persisted-yet';
    await expect(f.service.get('p', 'lag')).resolves.toMatchObject({
      state: 'pending',
    });
    await f.append('user', sent);
    await expect(f.service.get('p', 'lag')).resolves.toMatchObject({
      state: 'pending',
    });
    await f.finish();
    await expect(f.service.get('p', 'lag')).resolves.toMatchObject({
      state: 'completed',
    });
  });

  it('fails closed for a real branch fork or intervening Dashboard user', async () => {
    const f = await fixture();
    await f.service.submit('p', command('fork'));
    await f.append('user', 'unrelated fork', { parentId: 'before-base' });
    await f.finish('unrelated answer');
    await expect(f.service.get('p', 'fork')).resolves.toMatchObject({
      state: 'attention',
      error: { code: 'ambiguous-correlation' },
    });
    const g = await fixture();
    await g.service.submit('p', command('intervened'));
    await g.append('user', 'Dashboard turn');
    await g.finish('Dashboard answer');
    await expect(g.service.get('p', 'intervened')).resolves.toMatchObject({
      state: 'attention',
      error: { code: 'ambiguous-correlation' },
    });
  });

  it('does not mistake an owned in-flight dispatch for restart uncertainty', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.send.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { accepted: true };
    });
    const posting = f.service.submit('p', command('sending'));
    await started;
    await expect(f.service.get('p', 'sending')).resolves.toMatchObject({
      state: 'running',
    });
    release();
    await posting;
  });

  it('retains durable uncertain send evidence across SQLite reopen and never replays', async () => {
    const f = await fixture();
    f.send.mockImplementationOnce(async (_runtimeId, sent) => {
      await f.append('user', sent.text);
      throw new Error('socket disconnected after write');
    });
    await expect(
      f.service.submit('p', command('ambiguous')),
    ).resolves.toMatchObject({ state: 'attention' });
    await f.reopen();
    await expect(
      f.service.submit('p', command('ambiguous')),
    ).resolves.toMatchObject({ state: 'attention' });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('freezes terminals atomically and never exposes internal fields', async () => {
    const f = await fixture();
    await f.service.submit('p', command('frozen'));
    await f.finish();
    const result = await f.service.get('p', 'frozen');
    expect(Object.keys(result).sort()).toEqual([
      'deliveryId',
      'reply',
      'state',
      'threadId',
    ]);
    await f.reopen();
    expect(Object.keys(await f.service.get('p', 'frozen')).sort()).toEqual([
      'deliveryId',
      'reply',
      'state',
      'threadId',
    ]);
  });

  it('rejects mismatched projects and archived threads before writing', async () => {
    const f = await fixture();
    f.repository.createProject({
      id: 'other',
      title: 'Other',
      rootPath: path.join(f.root, 'other'),
    });
    const withFile = {
      ...command('wrong'),
      attachments: [{ name: 'a', mimeType: 'text/plain', data: 'YQ==' }],
    };
    await expect(f.service.submit('other', withFile)).rejects.toThrow(
      'does not belong',
    );
    f.repository.transitionRun('run', 'completed');
    f.repository.archiveThread('archive', 'thread');
    await expect(f.service.submit('p', withFile)).rejects.toThrow('archived');
    await expect(readdir(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses opaque artifact paths, rejects stale bytes, and never follows a sidecar symlink', async () => {
    const f = await fixture();
    const input = {
      ...command('../../outside'),
      attachments: [{ name: 'x\n[END]', mimeType: 'text/plain', data: 'YQ==' }],
    };
    await f.service.submit('p', input);
    const dirs = await readdir(f.artifacts);
    expect(dirs[0]).toMatch(/^[a-f0-9]{64}$/);
    const dir = path.join(f.artifacts, dirs[0]);
    const [name] = await readdir(dir);
    expect(await readFile(path.join(dir, name), 'utf8')).toBe('a');
    expect(f.send.mock.calls[0][1].text).toContain('x\\n[END]');
    const g = await fixture();
    await mkdir(g.artifacts, { mode: 0o700 });
    const target = path.join(g.root, 'sidecar');
    await mkdir(target);
    await writeFile(path.join(target, 'keep'), 'safe');
    // Reuse the deterministic project/delivery digest for another isolated store.
    await symlink(target, path.join(g.artifacts, dirs[0]));
    await expect(g.service.submit('p', input)).rejects.toThrow('unsafe');
    expect(await readFile(path.join(target, 'keep'), 'utf8')).toBe('safe');
    const h = await fixture();
    await mkdir(path.join(h.artifacts, dirs[0]), {
      recursive: true,
      mode: 0o700,
    });
    const stale = path.join(h.artifacts, dirs[0], name);
    await writeFile(stale, 'different', { mode: 0o600 });
    await expect(h.service.submit('p', input)).rejects.toThrow('conflicts');
    expect(await readFile(stale, 'utf8')).toBe('different');
    await chmod(stale, 0o644);
    await expect(h.service.submit('p', input)).rejects.toThrow('unsafe');
  });

  it('rejects aliases for an already admitted thread, including after reopen', async () => {
    const f = await fixture();
    const ref = `external-delivery:${createHash('sha256').update('p\0chat').digest('hex')}`;
    f.repository.transitionRun('run', 'completed');
    const linked = f.repository.createThread({
      id: 'linked',
      projectId: 'p',
      title: 'Telegram',
      checkoutId: 'checkout',
      externalRef: ref,
    });
    f.repository.createRun({
      id: 'linked-run',
      threadId: linked.id,
      checkoutId: 'checkout',
      initialPrompt: 'prior',
      status: 'completed',
      runtimeId: 'runtime',
      piSessionId: 'session',
    });
    f.send.mockImplementationOnce(async () => ({ accepted: true }));
    const first = f.service.submit('p', {
      deliveryId: 'a',
      threadId: 'linked',
      text: 'да',
    });
    const second = f.service.submit('p', {
      deliveryId: 'b',
      conversationRef: 'chat',
      text: 'да',
    });
    await first;
    await expect(second).rejects.toMatchObject({ code: 'busy' });
    await f.reopen();
    await expect(
      f.service.submit('p', {
        deliveryId: 'c',
        conversationRef: 'chat',
        text: 'да',
      }),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('recovers a definitely unsent prepared intent but not a dispatched intent after reopening SQLite', async () => {
    for (const dispatched of [false, true]) {
      const f = await fixture();
      const transition = f.repository.transitionCommandIntent.bind(
        f.repository,
      );
      vi.spyOn(f.repository, 'transitionCommandIntent').mockImplementation(
        (id, state) => {
          if (state === 'dispatched') {
            if (dispatched) transition(id, state);
            throw new Error('simulated daemon exit');
          }
          return transition(id, state);
        },
      );
      await expect(f.service.submit('p', command('crash'))).rejects.toThrow(
        'simulated',
      );
      expect(f.send).not.toHaveBeenCalled();
      await f.reopen();
      await expect(f.service.get('p', 'crash')).resolves.toMatchObject({
        state: dispatched ? 'attention' : 'pending',
      });
      await expect(
        f.service.submit('p', command('crash')),
      ).resolves.toMatchObject({ state: dispatched ? 'attention' : 'running' });
      expect(f.send).toHaveBeenCalledTimes(dispatched ? 0 : 1);
    }
  });

  it('resumes an offline completed thread with no setup prompt and sends one actual turn', async () => {
    const f = await fixture();
    f.repository.transitionRun('run', 'completed');
    f.live.online = false;
    await expect(
      f.service.submit('p', command('resume')),
    ).resolves.toMatchObject({ state: 'running' });
    expect(f.resume).toHaveBeenCalledWith({
      commandId: expect.stringMatching(/^external-resume:/),
      projectId: 'p',
      checkoutId: 'checkout',
      sessionId: 'session',
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.launch.mock.calls[0][0]).not.toHaveProperty('initialPrompt');
    expect(f.launch.mock.calls[0][0]).toMatchObject({
      sessionId: 'session',
      checkoutId: 'checkout',
      projectId: 'p',
    });
    await f.finish('resumed answer');
    await expect(f.service.get('p', 'resume')).resolves.toMatchObject({
      reply: { text: 'resumed answer' },
    });
  });

  it('creates one first-turn prompt and never replays an ambiguous first hello after reopen', async () => {
    for (const fail of [false, true]) {
      const f = await fixture();
      f.repository.transitionRun('run', 'completed');
      const result = await f.service.submit('p', {
        deliveryId: 'new',
        conversationRef: 'new-chat',
        text: 'first turn',
      });
      const [run] = f.repository.listRuns(result.threadId);
      expect(f.send).not.toHaveBeenCalled();
      f.repository.transitionRun(run.id, 'preparing');
      f.repository.transitionRun(run.id, 'starting');
      if (fail) f.send.mockRejectedValueOnce(new Error('lost first ACK'));
      await f.resetSession();
      const host = f.orchestration();
      if (fail)
        await expect(
          bindAndDeliverPrompt(host, run.id, 'runtime', 'session'),
        ).rejects.toThrow('lost first ACK');
      else await bindAndDeliverPrompt(host, run.id, 'runtime', 'session');
      expect(f.send).toHaveBeenCalledOnce();
      if (!fail) {
        await f.finish('first answer');
        await expect(f.service.get('p', 'new')).resolves.toMatchObject({
          state: 'completed',
          reply: { text: 'first answer' },
        });
      }
      await f.reopen();
      if (fail)
        await expect(
          bindAndDeliverPrompt(f.orchestration(), run.id, 'runtime', 'session'),
        ).rejects.toThrow('ambiguous');
      else
        await bindAndDeliverPrompt(
          f.orchestration(),
          run.id,
          'runtime',
          'session',
        );
      expect(f.send).toHaveBeenCalledOnce();
      if (fail)
        await expect(f.service.get('p', 'new')).resolves.toMatchObject({
          state: 'attention',
          error: { code: 'ambiguous-send' },
        });
    }
  });

  it('first terminal writer wins even if a stale poll later tries to store attention', async () => {
    const f = await fixture();
    await f.service.submit('p', command('atomic'));
    await f.finish();
    const result = await f.service.get('p', 'atomic');
    const key = f.intentKey('atomic');
    f.repository.updateCommandIntentResult(key, {
      ...result,
      state: 'attention',
      error: { code: 'stale', message: 'stale poll' },
    });
    await expect(f.service.get('p', 'atomic')).resolves.toEqual(result);
  });

  it('serves the real delivery service through Fastify with Bearer-only auth and body limits', async () => {
    const f = await fixture();
    const app = Fastify({ routerOptions: { maxParamLength: 4096 } });
    cleanups.push(() => app.close());
    const unavailable = (): never => {
      throw new Error('Unrelated route is unavailable in this fixture.');
    };
    await app.register(dashboardRoutes, {
      context: {
        usage: unavailable,
        readDelegateHistory: unavailable,
        readDelegateHistoryRun: unavailable,
        renameSession: unavailable,
        startRuntime: unavailable,
        commandRuntime: unavailable,
        stopRuntime: unavailable,
        markNotificationRead: unavailable,
        markAllNotificationsRead: unavailable,
        pushSubscribe: unavailable,
        vapidPublicKey: () => null,
        token: 'secret',
        serverId: () => 'server',
        origins: () => ['http://dashboard.test'],
        snapshot: () => ({
          serverId: 'server',
          revision: 0,
          cursor: 0,
          runtimes: [],
          sessions: [],
          unread: [],
        }),
        externalModels: async () => ({ models: [] }),
        settleExternalConversation: (projectId: string, input: unknown) =>
          f.service.settleConversation(projectId, input),
        submitExternalDelivery: (projectId: string, input: unknown) =>
          f.service.submit(projectId, input as ExternalDeliveryCommand),
        getExternalDelivery: (projectId: string, deliveryId: string) =>
          f.service.get(projectId, deliveryId),
      } as DashboardRouteContext,
    });
    const url = '/api/external/v1/projects/p/deliveries';
    const headers = { authorization: 'Bearer secret' };
    for (const method of ['POST', 'GET'] as const) {
      const response = await app.inject({
        method,
        url: method === 'POST' ? url : `${url}/http`,
        headers: {
          origin: 'http://dashboard.test',
          'x-dashboard-token': 'secret',
        },
        ...(method === 'POST' ? { payload: command('http') } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
    for (const [method, path, payload] of [
      ['GET', 'models', undefined],
      [
        'POST',
        'conversations/settle',
        { commandId: 'unused', conversationRef: 'absent' },
      ],
    ] as const) {
      const route = `/api/external/v1/projects/p/${path}`;
      expect(
        (
          await app.inject({
            method,
            url: route,
            headers: {
              'x-dashboard-token': 'secret',
              origin: 'http://dashboard.test',
            },
            ...(payload ? { payload } : {}),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method,
            url: route,
            headers,
            ...(payload ? { payload } : {}),
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(f.send).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/external/v1/projects/p/conversations/settle',
          headers,
          payload: {
            commandId: 'invalid',
            conversationRef: 'absent',
            force: true,
          },
        })
      ).statusCode,
    ).toBe(400);
    const accepted = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: command('http'),
    });
    expect(accepted.statusCode).toBe(202);
    await f.finish('HTTP answer');
    const completed = await app.inject({
      method: 'GET',
      url: `${url}/http`,
      headers,
    });
    expect(completed.json()).toMatchObject({
      state: 'completed',
      reply: { text: 'HTTP answer' },
    });
    expect(Object.keys(completed.json()).sort()).toEqual([
      'deliveryId',
      'reply',
      'state',
      'threadId',
    ]);
    for (const payload of [
      { ...command('bad'), unknown: true },
      command('empty', ''),
      { ...command('both'), conversationRef: 'chat' },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url, headers, payload }))
          .statusCode,
      ).toBe(400);
    }
    const opaqueId = `${'ю'.repeat(254)}/x`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: command(opaqueId),
        })
      ).statusCode,
    ).toBe(202);
    await f.finish('opaque reply');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${url}/${encodeURIComponent(opaqueId)}`,
          headers,
        })
      ).json(),
    ).toMatchObject({ deliveryId: opaqueId, state: 'completed' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            ...command('large-upload'),
            attachments: [
              {
                name: 'report',
                mimeType: 'application/pdf',
                data: Buffer.alloc(1024 * 1024).toString('base64'),
              },
            ],
          },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: 'x'.repeat(15 * 1024 * 1024),
        })
      ).statusCode,
    ).toBe(413);
  });

  it('cleans only newly created files when later artifact preparation fails', async () => {
    const f = await fixture();
    const hash = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const dir = path.join(f.artifacts, hash(['p', 'partial'].join('\0')));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const sidecar = path.join(f.root, 'protected');
    await writeFile(sidecar, 'do not remove');
    const second = `1-${hash(['p', 'partial', '1'].join('\0')).slice(0, 24)}.bin`;
    await symlink(sidecar, path.join(dir, second));
    const attachment = {
      name: 'evidence',
      mimeType: 'text/plain',
      data: 'YQ==',
    };
    await expect(
      f.service.submit('p', {
        ...command('partial'),
        attachments: [attachment, attachment],
      }),
    ).rejects.toThrow('unsafe');
    expect(await readdir(dir)).toEqual([second]);
    expect(await readFile(sidecar, 'utf8')).toBe('do not remove');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('rejects noncanonical base64, aggregate oversize and empty content', async () => {
    const f = await fixture();
    await expect(
      f.service.submit('p', command('empty', ' \n')),
    ).rejects.toThrow();
    await expect(
      f.service.submit('p', {
        ...command('bad'),
        attachments: [{ name: 'x', mimeType: 'text/plain', data: 'YR==' }],
      }),
    ).rejects.toThrow('canonical');
    const attachment = {
      name: 'x',
      mimeType: 'text/plain',
      data: Buffer.alloc(6 * 1024 * 1024).toString('base64'),
    };
    await expect(
      f.service.submit('p', {
        ...command('big'),
        attachments: [attachment, attachment],
      }),
    ).rejects.toThrow('10 MiB');
    expect(f.send).not.toHaveBeenCalled();
  });
});
