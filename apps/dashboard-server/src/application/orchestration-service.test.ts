import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { MetadataStore } from '../metadata.js';
import { OrchestrationService } from './orchestration-service.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args]);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec('git', ['-C', cwd, ...args]);
  return result.stdout;
}

function workspace(root: string) {
  return {
    id: 'workspace-main',
    name: 'main',
    path: root,
    canonicalPath: root,
    source: 'directory' as const,
    tmuxSession: 'dashboard',
    active: true,
  };
}

async function orchestrationFixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'pi-orchestration-matrix-'),
  );
  const state = await mkdtemp(
    path.join(os.tmpdir(), 'pi-orchestration-matrix-state-'),
  );
  const metadata = new MetadataStore(path.join(state, 'dashboard.sqlite'));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.test');
  await git(root, 'config', 'user.name', 'Test');
  await writeFile(path.join(root, 'tracked.txt'), 'base\\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'base');
  let live: Record<string, unknown> | undefined;
  const registry = {
    get: (runtimeId: string) =>
      live?.runtimeId === runtimeId ? (live as never) : undefined,
    sendCommand: vi.fn(async () => ({ accepted: true })),
  };
  const manager = {
    launch: vi.fn(async (input: { runtimeId?: string }) => ({
      runtimeId: input.runtimeId,
    })),
    recover: vi.fn(async () => false),
    stopRecovered: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const service = new OrchestrationService({
    repository: metadata.orchestration,
    manager: manager as never,
    registry: registry as never,
    workspaces: () => [workspace(root)],
    reconnectGraceMs: 25,
  });
  const adopted = (await service.adoptProject({
    commandId: 'matrix-adopt',
    rootPath: root,
  })) as { project: { id: string } };
  const created = (await service.createThread(adopted.project.id, {
    commandId: 'matrix-thread',
    title: 'Matrix run',
    prompt: 'Matrix prompt',
    isolation: 'main',
  })) as { run: { id: string } };
  return {
    root,
    state,
    metadata,
    service,
    manager,
    registry,
    runId: created.run.id,
    setLive(value: Record<string, unknown> | undefined) {
      live = value;
    },
    async close() {
      await service.stop();
      metadata.close();
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    },
  };
}

async function reconcile(service: OrchestrationService): Promise<void> {
  await (service as unknown as { reconcile: () => Promise<void> }).reconcile();
}

function runtimeHello(runtimeId: string): Record<string, unknown> {
  return {
    runtimeId,
    ownership: 'managed',
    pid: 1,
    cwd: '/tmp',
    liveState: 'working',
    session: { id: `${runtimeId}-session`, entries: [] },
    pendingInteractions: [],
    online: true,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for orchestration state.');
}

async function isolatedServiceFixture(
  options: {
    failingHook?: boolean;
    beforeWorktreePreparation?: () => Promise<void>;
    beforeWorktreeFinish?: () => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-orchestration-git-'));
  const state = await mkdtemp(
    path.join(os.tmpdir(), 'pi-orchestration-git-state-'),
  );
  const metadata = new MetadataStore(path.join(state, 'dashboard.sqlite'));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.test');
  await git(root, 'config', 'user.name', 'Test');
  await writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'base');
  if (options.failingHook) {
    const hook = path.join(root, '.git', 'hooks', 'post-checkout');
    await writeFile(
      hook,
      '#!/bin/sh\nprintf "hook failure %s" "x" >&2\nexit 17\n',
    );
    await chmod(hook, 0o755);
  }
  const launches: Array<Record<string, unknown>> = [];
  let live: Record<string, unknown> | undefined;
  const manager = {
    launch: vi.fn(async (input: Record<string, unknown>) => {
      launches.push(input);
      return { runtimeId: input.runtimeId as string };
    }),
    hasLaunch: vi.fn(() => false),
    recover: vi.fn(async () => false),
    stopRecovered: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const registry = {
    get: (runtimeId: string) =>
      live?.runtimeId === runtimeId ? (live as never) : undefined,
    sendCommand: vi.fn(async () => ({ accepted: true })),
  };
  const service = new OrchestrationService({
    repository: metadata.orchestration,
    manager: manager as never,
    registry: registry as never,
    workspaces: () => [workspace(root)],
    pollMs: 5,
    beforeWorktreePreparation: options.beforeWorktreePreparation,
    beforeWorktreeFinish: options.beforeWorktreeFinish,
  });
  const adopted = (await service.adoptProject({
    commandId: `adopt-${Date.now()}-${Math.random()}`,
    rootPath: root,
    maxParallelRuns: 1,
  })) as { project: { id: string } };
  return {
    root,
    state,
    metadata,
    service,
    manager,
    registry,
    projectId: adopted.project.id,
    launches,
    setLive(value: Record<string, unknown> | undefined) {
      live = value;
    },
    async close() {
      await service.stop();
      metadata.close();
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    },
  };
}

describe('OrchestrationService', () => {
  it('replays isolated create without allocating an orphan checkout', async () => {
    const fixture = await isolatedServiceFixture();
    try {
      const command = {
        commandId: 'isolated-replay',
        title: 'Once',
        prompt: 'Do it once.',
      };
      const first = await fixture.service.createThread(
        fixture.projectId,
        command,
      );
      const replay = await fixture.service.createThread(fixture.projectId, {
        ...command,
        title: 'Must not replace',
        prompt: 'Must not replace.',
      });
      expect(replay).toEqual(first);
      expect(
        fixture.metadata.orchestration.listCheckouts(fixture.projectId),
      ).toHaveLength(2);
      expect(
        fixture.metadata.orchestration.listThreads(fixture.projectId),
      ).toHaveLength(1);
      expect(fixture.metadata.orchestration.listRuns()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it('rejects new work and execution on a retired checkout without launching', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      const current = repository.getCheckout(
        repository.getRun(fixture.runId)?.checkoutId ?? '',
      );
      if (!current) throw new Error('Missing fixture checkout.');
      repository.transitionCheckout(current.id, 'retired');
      await expect(
        fixture.service.createThread(
          repository.getProject(current.projectId)?.id ?? '',
          {
            commandId: 'retired-new-thread',
            title: 'Rejected',
            prompt: 'Must not create.',
            checkoutId: current.id,
            isolation: 'main',
          },
        ),
      ).rejects.toMatchObject({ code: 'orchestration-conflict' });
      await fixture.service.start();
      await waitFor(
        () => repository.getRun(fixture.runId)?.status === 'failed',
      );
      expect(fixture.manager.launch).not.toHaveBeenCalled();
      expect(repository.listThreads()).toHaveLength(1);
      expect(repository.listRuns()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it('requeues preparing runs and leaves them claimable during reconciliation', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      await reconcile(fixture.service);
      expect(repository.getRun(fixture.runId)?.status).toBe('queued');
      expect(repository.claimQueuedRun(fixture.runId)?.status).toBe(
        'preparing',
      );
      expect(fixture.manager.launch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('interrupts a starting run with no durable runtime identity', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      await reconcile(fixture.service);
      expect(repository.getRun(fixture.runId)?.status).toBe('interrupted');
      expect(fixture.manager.launch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('binds a live running run without launching another manager runtime', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.transitionRun(fixture.runId, 'running');
      repository.setRunRuntime(fixture.runId, 'runtime-live');
      fixture.setLive(runtimeHello('runtime-live'));
      await reconcile(fixture.service);
      expect(fixture.manager.launch).not.toHaveBeenCalled();
      expect(repository.getRuntime('runtime-live')?.piSessionId).toBe(
        'runtime-live-session',
      );
      expect(repository.getRun(fixture.runId)?.status).toBe('running');
      expect(
        repository.getCommandReceipt(`run-prompt:${fixture.runId}`),
      ).toBeDefined();
    } finally {
      await fixture.close();
    }
  });

  it('waits for a recovered runtime hello and binds without launching', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.transitionRun(fixture.runId, 'running');
      repository.setRunRuntime(fixture.runId, 'runtime-restored');
      fixture.manager.recover.mockResolvedValueOnce(true);
      const reconciliation = reconcile(fixture.service);
      expect(fixture.manager.recover).toHaveBeenCalledWith('runtime-restored');
      queueMicrotask(() => fixture.setLive(runtimeHello('runtime-restored')));
      await reconciliation;
      expect(fixture.manager.launch).not.toHaveBeenCalled();
      expect(repository.getRun(fixture.runId)?.status).toBe('running');
      expect(repository.getRuntime('runtime-restored')?.status).toBe('running');
    } finally {
      await fixture.close();
    }
  });

  it('interrupts and stops an unreconnected recovered runtime after grace', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.transitionRun(fixture.runId, 'running');
      repository.setRunRuntime(fixture.runId, 'runtime-lost');
      fixture.manager.recover.mockResolvedValueOnce(true);
      await reconcile(fixture.service);
      expect(fixture.manager.launch).not.toHaveBeenCalled();
      expect(fixture.manager.stopRecovered).toHaveBeenCalledOnce();
      expect(repository.getRun(fixture.runId)?.status).toBe('interrupted');
    } finally {
      await fixture.close();
    }
  });

  it('shares concurrent registered callbacks and sends one initial prompt', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.setRunRuntime(fixture.runId, 'runtime-duplicate');
      const change = {
        kind: 'registered' as const,
        snapshot: runtimeHello('runtime-duplicate'),
      };
      const handle = (
        fixture.service as unknown as {
          handleRegistryChange: (value: typeof change) => Promise<void>;
        }
      ).handleRegistryChange.bind(fixture.service);
      await Promise.all([handle(change), handle(change)]);
      expect(fixture.registry.sendCommand).toHaveBeenCalledOnce();
      expect(repository.getRun(fixture.runId)?.status).toBe('running');
    } finally {
      await fixture.close();
    }
  });

  it('serializes hello prompt ACK before consecutive interaction and settled events', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.setRunRuntime(fixture.runId, 'runtime-ordered');
      let releasePrompt!: () => void;
      const prompt = new Promise<{ accepted: boolean }>((resolve) => {
        releasePrompt = () => resolve({ accepted: true });
      });
      fixture.registry.sendCommand.mockImplementationOnce(async () => prompt);
      const handle = (
        fixture.service as unknown as {
          handleRegistryChange: (value: never) => Promise<void>;
        }
      ).handleRegistryChange.bind(fixture.service);
      const interaction = { id: 'ordered-question', type: 'ask_user' };
      const registered = handle({
        kind: 'registered',
        snapshot: {
          ...runtimeHello('runtime-ordered'),
          pendingInteractions: [interaction],
        },
      } as never);
      const requested = handle({
        kind: 'event',
        runtimeId: 'runtime-ordered',
        event: { type: 'interaction.requested', interaction },
        snapshot: {
          ...runtimeHello('runtime-ordered'),
          pendingInteractions: [interaction],
        },
      } as never);
      const settled = handle({
        kind: 'event',
        runtimeId: 'runtime-ordered',
        event: { type: 'agent.settled', sessionId: 'ordered-session' },
        snapshot: {
          ...runtimeHello('runtime-ordered'),
          pendingInteractions: [],
        },
      } as never);
      await Promise.resolve();
      expect(repository.getRun(fixture.runId)?.status).toBe('starting');
      releasePrompt();
      await Promise.all([registered, requested, settled]);
      expect(repository.getRun(fixture.runId)?.status).toBe('settled');
      expect(
        repository.getThread(repository.getRun(fixture.runId)?.threadId ?? '')
          ?.status,
      ).toBe('settled');
    } finally {
      await fixture.close();
    }
  });

  it('stops durable runtime on goodbye but preserves reload reconnect intent', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.setRunRuntime(fixture.runId, 'runtime-goodbye');
      const handle = (
        fixture.service as unknown as {
          handleRegistryChange: (value: never) => Promise<void>;
        }
      ).handleRegistryChange.bind(fixture.service);
      await handle({
        kind: 'registered',
        snapshot: runtimeHello('runtime-goodbye'),
      } as never);
      await handle({
        kind: 'event',
        runtimeId: 'runtime-goodbye',
        event: { type: 'runtime.goodbye', reason: 'quit' },
        snapshot: { ...runtimeHello('runtime-goodbye'), online: false },
      } as never);
      expect(repository.getRun(fixture.runId)?.status).toBe('interrupted');
      expect(repository.getRuntime('runtime-goodbye')?.status).toBe('stopped');
    } finally {
      await fixture.close();
    }

    const reload = await orchestrationFixture();
    try {
      const repository = reload.metadata.orchestration;
      repository.transitionRun(reload.runId, 'preparing');
      repository.transitionRun(reload.runId, 'starting');
      repository.setRunRuntime(reload.runId, 'runtime-reload');
      const handle = (
        reload.service as unknown as {
          handleRegistryChange: (value: never) => Promise<void>;
        }
      ).handleRegistryChange.bind(reload.service);
      await handle({
        kind: 'registered',
        snapshot: runtimeHello('runtime-reload'),
      } as never);
      await handle({
        kind: 'event',
        runtimeId: 'runtime-reload',
        event: { type: 'runtime.goodbye', reason: 'reload' },
        snapshot: { ...runtimeHello('runtime-reload'), online: false },
      } as never);
      expect(repository.getRun(reload.runId)?.status).toBe('running');
      await handle({
        kind: 'registered',
        snapshot: runtimeHello('runtime-reload'),
      } as never);
      expect(repository.getRun(reload.runId)?.status).toBe('running');
    } finally {
      await reload.close();
    }
  });

  it('stops and interrupts durable state when a runtime goes offline', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.setRunRuntime(fixture.runId, 'runtime-offline');
      const handle = (
        fixture.service as unknown as {
          handleRegistryChange: (value: never) => Promise<void>;
        }
      ).handleRegistryChange.bind(fixture.service);
      await handle({
        kind: 'registered',
        snapshot: runtimeHello('runtime-offline'),
      } as never);
      await handle({
        kind: 'offline',
        snapshot: { ...runtimeHello('runtime-offline'), online: false },
      } as never);
      expect(repository.getRun(fixture.runId)?.status).toBe('interrupted');
      expect(repository.getRuntime('runtime-offline')?.status).toBe('stopped');
    } finally {
      await fixture.close();
    }
  });

  it('serializes settled work before a following normal goodbye', async () => {
    let enteredFinish = false;
    let releaseFinish!: () => void;
    const finish = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    const fixture = await isolatedServiceFixture({
      beforeWorktreeFinish: async () => {
        enteredFinish = true;
        await finish;
      },
    });
    try {
      await fixture.service.start();
      const created = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'settled-goodbye-thread',
        title: 'Settled goodbye',
        prompt: 'Settle before goodbye.',
      })) as { run: { id: string; checkoutId: string } };
      await waitFor(() => fixture.launches.length === 1);
      const runtimeId = fixture.launches[0]?.runtimeId as string;
      const handle = (
        fixture.service as unknown as {
          handleRegistryChange: (value: never) => Promise<void>;
        }
      ).handleRegistryChange.bind(fixture.service);
      await handle({
        kind: 'registered',
        snapshot: runtimeHello(runtimeId),
      } as never);
      await waitFor(
        () =>
          fixture.metadata.orchestration.getRun(created.run.id)?.status ===
          'running',
      );
      fixture.service.onRegistryChange({
        kind: 'event',
        runtimeId,
        event: { type: 'agent.settled', sessionId: `${runtimeId}-session` },
        snapshot: {} as never,
      });
      await waitFor(() => enteredFinish);
      expect(
        fixture.metadata.orchestration.getRun(created.run.id)?.status,
      ).toBe('settled');
      fixture.service.onRegistryChange({
        kind: 'event',
        runtimeId,
        event: { type: 'runtime.goodbye', reason: 'quit' },
        snapshot: { ...runtimeHello(runtimeId), online: false } as never,
      });
      releaseFinish();
      await fixture.service.stop();
      expect(
        fixture.metadata.orchestration.getRun(created.run.id)?.status,
      ).toBe('settled');
      expect(fixture.metadata.orchestration.getRuntime(runtimeId)?.status).toBe(
        'stopped',
      );
    } finally {
      await fixture.close();
    }
  });

  it('does not record a rejected prompt and retries it on a later hello', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.setRunRuntime(fixture.runId, 'runtime-retry');
      fixture.registry.sendCommand.mockRejectedValueOnce(new Error('ACK lost'));
      const change = {
        kind: 'registered' as const,
        snapshot: runtimeHello('runtime-retry'),
      };
      const handle = (
        fixture.service as unknown as {
          handleRegistryChange: (value: typeof change) => Promise<void>;
        }
      ).handleRegistryChange.bind(fixture.service);
      await handle(change);
      expect(
        repository.getCommandReceipt(`run-prompt:${fixture.runId}`),
      ).toBeUndefined();
      expect(repository.getRun(fixture.runId)?.status).toBe('starting');
      await handle(change);
      expect(fixture.registry.sendCommand).toHaveBeenCalledTimes(2);
      expect(
        repository.getCommandReceipt(`run-prompt:${fixture.runId}`),
      ).toBeDefined();
      expect(repository.getRun(fixture.runId)?.status).toBe('running');
      expect(repository.getRun(fixture.runId)?.error).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it('projects interaction requests and resolutions from authoritative snapshots', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.setRunRuntime(fixture.runId, 'runtime-attention');
      repository.transitionRun(fixture.runId, 'running');
      const handle = (
        fixture.service as unknown as {
          handleRegistryChange: (value: never) => Promise<void>;
        }
      ).handleRegistryChange.bind(fixture.service);
      const interaction = { id: 'question-1', type: 'ask_user' };
      const secondInteraction = { id: 'question-2', type: 'ask_user' };
      const change = (event: unknown, pendingInteractions: unknown[]) =>
        ({
          kind: 'event',
          runtimeId: 'runtime-attention',
          event,
          snapshot: {
            ...runtimeHello('runtime-attention'),
            pendingInteractions,
          },
        }) as never;

      await handle(
        change({ type: 'interaction.requested', interaction }, [interaction]),
      );
      expect(repository.getRun(fixture.runId)?.status).toBe('waiting');
      expect(
        repository.getThread(repository.getRun(fixture.runId)?.threadId ?? '')
          ?.status,
      ).toBe('needs-input');

      await handle(
        change(
          { type: 'interaction.requested', interaction: secondInteraction },
          [interaction, secondInteraction],
        ),
      );
      await handle(
        change(
          {
            type: 'interaction.resolved',
            interactionId: 'question-1',
            resolution: 'yes',
          },
          [secondInteraction],
        ),
      );
      expect(repository.getRun(fixture.runId)?.status).toBe('waiting');

      await handle(
        change({ type: 'runtime.stateChanged', state: 'working' }, [
          secondInteraction,
        ]),
      );
      expect(repository.getRun(fixture.runId)?.status).toBe('waiting');

      await handle(
        change(
          {
            type: 'interaction.resolved',
            interactionId: 'question-2',
            resolution: 'no',
          },
          [],
        ),
      );
      expect(repository.getRun(fixture.runId)?.status).toBe('running');
      expect(
        repository.getThread(repository.getRun(fixture.runId)?.threadId ?? '')
          ?.status,
      ).toBe('active');
    } finally {
      await fixture.close();
    }
  });

  it('makes concurrent and sequential cancellation replay the same result', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.transitionRun(fixture.runId, 'preparing');
      repository.transitionRun(fixture.runId, 'starting');
      repository.setRunRuntime(fixture.runId, 'cancel-runtime');
      let release!: () => void;
      const stopped = new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
      fixture.manager.stop.mockImplementationOnce(async () => stopped);
      const first = fixture.service.cancelRun(fixture.runId, 'cancel-once');
      const second = fixture.service.cancelRun(fixture.runId, 'cancel-once');
      await Promise.resolve();
      expect(fixture.manager.stop).toHaveBeenCalledOnce();
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(two).toEqual(one);
      expect(
        await fixture.service.cancelRun(fixture.runId, 'cancel-once'),
      ).toEqual(one);
      expect(fixture.manager.stop).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });

  it('cancels a worktree run while launch is pending and stops the eventual placement', async () => {
    const fixture = await isolatedServiceFixture();
    try {
      let resolveLaunch!: (value: { runtimeId: string }) => void;
      const launch = new Promise<{ runtimeId: string }>((resolve) => {
        resolveLaunch = resolve;
      });
      fixture.manager.launch.mockImplementationOnce(async (input) => {
        fixture.launches.push(input);
        return launch;
      });
      await fixture.service.start();
      const created = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'cancel-pending-launch-thread',
        title: 'Cancel pending launch',
        prompt: 'Cancel me.',
      })) as { run: { id: string; checkoutId: string } };
      await waitFor(() => fixture.launches.length === 1);
      const runtimeId = fixture.launches[0]?.runtimeId as string;
      const cancellation = fixture.service.cancelRun(
        created.run.id,
        'cancel-pending-launch',
      );
      await waitFor(
        () =>
          fixture.metadata.orchestration.getRun(created.run.id)?.status ===
          'cancelled',
      );
      resolveLaunch({ runtimeId });
      await cancellation;
      expect(fixture.manager.stop).toHaveBeenCalledOnce();
      expect(fixture.manager.stop).toHaveBeenCalledWith(runtimeId, true);
      expect(
        fixture.metadata.orchestration.loadWorktreeRecord(
          created.run.checkoutId,
        ),
      ).toBeUndefined();
      expect(
        await readdir(path.join(fixture.root, '.worktrees')).catch(() => []),
      ).toEqual([]);
      expect(
        fixture.metadata.orchestration.getCheckout(created.run.checkoutId)
          ?.status,
      ).toBe('retired');
    } finally {
      await fixture.close();
    }
  });

  it('preserves edits when cancelling an ordinary running worktree', async () => {
    const fixture = await isolatedServiceFixture();
    try {
      await fixture.service.start();
      const created = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'cancel-running-thread',
        title: 'Cancel running',
        prompt: 'Cancel after edits.',
      })) as { run: { id: string; checkoutId: string } };
      await waitFor(() => fixture.launches.length === 1);
      const runtimeId = fixture.launches[0]?.runtimeId as string;
      const checkoutPath = String(fixture.launches[0]?.checkoutCwd);
      fixture.service.onRegistryChange({
        kind: 'registered',
        snapshot: {
          ...runtimeHello(runtimeId),
          cwd: checkoutPath,
        } as never,
      });
      await waitFor(
        () =>
          fixture.metadata.orchestration.getRun(created.run.id)?.status ===
          'running',
      );
      await writeFile(path.join(checkoutPath, 'cancelled-edits.txt'), 'keep\n');
      await expect(
        fixture.service.cancelRun(created.run.id, 'cancel-running'),
      ).resolves.toMatchObject({ status: 'cancelled' });
      await expect(
        readFile(path.join(checkoutPath, 'cancelled-edits.txt'), 'utf8'),
      ).resolves.toBe('keep\n');
      const record = fixture.metadata.orchestration.loadWorktreeRecord(
        created.run.checkoutId,
      );
      expect(record?.status).toBe('finished');
      expect(
        await gitOutput(fixture.root, 'branch', '--list', record?.branch ?? ''),
      ).toContain(record?.branch ?? '');
      expect(
        fixture.metadata.orchestration.getCheckout(created.run.checkoutId)
          ?.status,
      ).toBe('dirty');
      expect(
        fixture.metadata.orchestration.getCheckout(created.run.checkoutId)
          ?.status,
      ).not.toBe('retired');
    } finally {
      await fixture.close();
    }
  });

  it('retries a rejected stop for an ordinary running cancellation', async () => {
    const fixture = await isolatedServiceFixture();
    try {
      fixture.manager.stop
        .mockRejectedValueOnce(new Error('running stop failed'))
        .mockResolvedValue(undefined);
      await fixture.service.start();
      const created = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'cancel-running-retry-thread',
        title: 'Cancel running retry',
        prompt: 'Retry stop.',
      })) as { run: { id: string; checkoutId: string } };
      await waitFor(() => fixture.launches.length === 1);
      const runtimeId = fixture.launches[0]?.runtimeId as string;
      const checkoutPath = String(fixture.launches[0]?.checkoutCwd);
      fixture.service.onRegistryChange({
        kind: 'registered',
        snapshot: { ...runtimeHello(runtimeId), cwd: checkoutPath } as never,
      });
      await waitFor(
        () =>
          fixture.metadata.orchestration.getRun(created.run.id)?.status ===
          'running',
      );
      await expect(
        fixture.service.cancelRun(created.run.id, 'cancel-running-retry'),
      ).rejects.toThrow('running stop failed');
      expect(
        fixture.metadata.orchestration.getCommandReceipt(
          'cancel-running-retry',
        ),
      ).toBeUndefined();
      expect(
        fixture.metadata.orchestration.getRun(created.run.id)?.error,
      ).toContain('running stop failed');
      const retained = fixture.metadata.orchestration.loadWorktreeRecord(
        created.run.checkoutId,
      );
      expect(retained?.status).toBe('active');
      await expect(access(checkoutPath)).resolves.toBeUndefined();

      const retry = await fixture.service.cancelRun(
        created.run.id,
        'cancel-running-retry',
      );
      expect(retry).toMatchObject({ status: 'cancelled' });
      expect((retry as { error?: string }).error).toBeUndefined();
      const receiptResult = fixture.metadata.orchestration.getCommandReceipt(
        'cancel-running-retry',
      )?.result as { status?: string; error?: string };
      expect(receiptResult.status).toBe('cancelled');
      expect(receiptResult.error).toBeUndefined();
      expect(fixture.manager.stop).toHaveBeenCalledTimes(2);
      expect(
        fixture.metadata.orchestration.loadWorktreeRecord(
          created.run.checkoutId,
        )?.status,
      ).toBe('finished');
    } finally {
      await fixture.close();
    }
  });

  it('retains cancellation evidence after stop failure and retries cleanup', async () => {
    const fixture = await isolatedServiceFixture();
    try {
      fixture.manager.hasLaunch.mockReturnValue(true);
      fixture.manager.stop
        .mockRejectedValueOnce(new Error('first provider stop failed'))
        .mockResolvedValue(undefined);
      let resolveLaunch!: (value: { runtimeId: string }) => void;
      const launch = new Promise<{ runtimeId: string }>((resolve) => {
        resolveLaunch = resolve;
      });
      fixture.manager.launch.mockImplementationOnce(async (input) => {
        fixture.launches.push(input);
        return launch;
      });
      await fixture.service.start();
      const created = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'cancel-stop-retry-thread',
        title: 'Cancel stop retry',
        prompt: 'Cancel with retry.',
      })) as { run: { id: string; checkoutId: string } };
      await waitFor(() => fixture.launches.length === 1);
      const runtimeId = fixture.launches[0]?.runtimeId as string;
      const first = fixture.service.cancelRun(
        created.run.id,
        'cancel-stop-retry',
      );
      await waitFor(
        () =>
          fixture.metadata.orchestration.getRun(created.run.id)?.status ===
          'cancelled',
      );
      resolveLaunch({ runtimeId });
      await expect(first).rejects.toThrow('first provider stop failed');
      expect(
        fixture.metadata.orchestration.getCommandReceipt('cancel-stop-retry'),
      ).toBeUndefined();
      expect(
        fixture.metadata.orchestration.getRun(created.run.id)?.error,
      ).toContain('first provider stop failed');
      const retained = fixture.metadata.orchestration.loadWorktreeRecord(
        created.run.checkoutId,
      );
      expect(retained).toBeDefined();
      await expect(
        access(retained?.worktreePath as string),
      ).resolves.toBeUndefined();

      await expect(
        fixture.service.cancelRun(created.run.id, 'cancel-stop-retry'),
      ).resolves.toMatchObject({ status: 'cancelled' });
      expect(fixture.manager.stop).toHaveBeenCalledTimes(2);
      expect(
        fixture.metadata.orchestration.getCommandReceipt('cancel-stop-retry'),
      ).toBeDefined();
      expect(
        fixture.metadata.orchestration.loadWorktreeRecord(
          created.run.checkoutId,
        ),
      ).toBeUndefined();
      await expect(
        access(retained?.worktreePath as string),
      ).rejects.toBeDefined();
      expect(
        fixture.metadata.orchestration.getCheckout(created.run.checkoutId)
          ?.status,
      ).toBe('retired');
    } finally {
      await fixture.close();
    }
  });

  it('cancels during preparation without leaking a worktree or branch', async () => {
    let enteredPreparation = false;
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const fixture = await isolatedServiceFixture({
      beforeWorktreePreparation: async () => {
        enteredPreparation = true;
        await preparation;
      },
    });
    try {
      await fixture.service.start();
      const created = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'cancel-preparation-thread',
        title: 'Cancel preparation',
        prompt: 'Cancel before launch.',
      })) as { run: { id: string; checkoutId: string } };
      await waitFor(() => enteredPreparation);
      const cancellation = fixture.service.cancelRun(
        created.run.id,
        'cancel-preparation',
      );
      await waitFor(
        () =>
          fixture.metadata.orchestration.getRun(created.run.id)?.status ===
          'cancelled',
      );
      expect(fixture.manager.launch).not.toHaveBeenCalled();
      releasePreparation();
      await expect(cancellation).resolves.toMatchObject({
        status: 'cancelled',
      });
      expect(
        fixture.metadata.orchestration.getCommandReceipt('cancel-preparation'),
      ).toBeDefined();
      expect(
        fixture.metadata.orchestration.loadWorktreeRecord(
          created.run.checkoutId,
        ),
      ).toBeUndefined();
      expect(
        await readdir(path.join(fixture.root, '.worktrees')).catch(() => []),
      ).toEqual([]);
      expect(await gitOutput(fixture.root, 'branch', '--list', 'pi/*')).toBe(
        '',
      );
      const worktreeLines = (
        await gitOutput(fixture.root, 'worktree', 'list', '--porcelain')
      )
        .split('\n')
        .filter((line) => line.startsWith('worktree '));
      expect(worktreeLines).toHaveLength(1);
      expect(
        fixture.metadata.orchestration.getCheckout(created.run.checkoutId)
          ?.status,
      ).toBe('retired');
    } finally {
      await fixture.close();
    }
  });

  it('returns a coded conflict when a command receipt belongs to another command', async () => {
    const fixture = await orchestrationFixture();
    try {
      const repository = fixture.metadata.orchestration;
      repository.recordCommandReceipt({
        idempotencyKey: 'owned-command',
        commandType: 'thread.archive',
        resourceType: 'thread',
        resourceId: 'thread-1',
        result: {},
        createdAt: Date.now(),
      });
      await expect(
        fixture.service.cancelRun(fixture.runId, 'owned-command'),
      ).rejects.toMatchObject({ code: 'idempotency-conflict' });
    } finally {
      await fixture.close();
    }
  });

  it('rejects retiring the project main checkout as an orchestration conflict', async () => {
    const fixture = await orchestrationFixture();
    try {
      const main = fixture.metadata.orchestration
        .listCheckouts()
        .find((checkout) => checkout.kind === 'main');
      expect(main).toBeDefined();
      await expect(
        fixture.service.retireCheckout(main?.id as string, 'retire-main'),
      ).rejects.toMatchObject({ code: 'orchestration-conflict' });
    } finally {
      await fixture.close();
    }
  });

  it('rejects merge and retire while a checkout still has an active run', async () => {
    const fixture = await isolatedServiceFixture();
    try {
      const created = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'active-checkout-thread',
        title: 'Active checkout',
        prompt: 'Still queued.',
      })) as { run: { checkoutId: string } };
      await expect(
        fixture.service.mergeCheckout(created.run.checkoutId, 'active-merge'),
      ).rejects.toMatchObject({ code: 'orchestration-conflict' });
      await expect(
        fixture.service.retireCheckout(created.run.checkoutId, 'active-retire'),
      ).rejects.toMatchObject({ code: 'orchestration-conflict' });
      expect(fixture.manager.stopRecovered).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('holds the second isolated run at maxParallelRuns until the first settles', async () => {
    const fixture = await isolatedServiceFixture();
    try {
      const first = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'parallel-thread-1',
        title: 'First isolated run',
        prompt: 'First',
      })) as { run: { id: string } };
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'parallel-thread-2',
        title: 'Second isolated run',
        prompt: 'Second',
      })) as { run: { id: string } };
      await fixture.service.start();
      await waitFor(() => fixture.launches.length === 1);
      const repository = fixture.metadata.orchestration;
      expect(repository.getRun(second.run.id)?.status).toBe('queued');
      const firstRun = repository.getRun(first.run.id);
      const firstRuntime = firstRun?.runtimeId as string;
      const firstPath = String(fixture.launches[0]?.checkoutCwd);
      fixture.service.onRegistryChange({
        kind: 'registered',
        snapshot: {
          ...runtimeHello(firstRuntime),
          cwd: firstPath,
          session: { id: 'parallel-session-1', entries: [] },
        } as never,
      });
      await waitFor(
        () => repository.getRun(first.run.id)?.status === 'running',
      );
      expect(fixture.launches).toHaveLength(1);
      fixture.service.onRegistryChange({
        kind: 'event',
        runtimeId: firstRuntime,
        event: { type: 'agent.settled', sessionId: 'parallel-session-1' },
        snapshot: {} as never,
      });
      await waitFor(
        () => repository.getRun(first.run.id)?.status === 'settled',
      );
      await waitFor(() => fixture.launches.length === 2);
      expect(repository.getRun(second.run.id)?.status).toBe('starting');
      expect(fixture.launches[1]?.checkoutCwd).not.toBe(firstPath);
    } finally {
      await fixture.close();
    }
  });

  it('fails closed on checkout hook preparation errors and removes fresh Git side effects', async () => {
    const fixture = await isolatedServiceFixture({ failingHook: true });
    try {
      const created = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'prep-failure-thread',
        title: 'Hook failure',
        prompt: 'This must not launch.',
      })) as { run: { id: string; checkoutId: string } };
      await fixture.service.start();
      const repository = fixture.metadata.orchestration;
      await waitFor(
        () => repository.getRun(created.run.id)?.status === 'failed',
      );
      const run = repository.getRun(created.run.id);
      const checkout = repository.getCheckout(created.run.checkoutId);
      expect(fixture.manager.launch).not.toHaveBeenCalled();
      expect(run?.error).toBeDefined();
      expect(run?.error?.length).toBeLessThanOrEqual(2_000);
      expect(checkout?.status).toBe('failed');
      expect(checkout?.kind).toBe('worktree');
      expect(
        repository.loadWorktreeRecord(checkout?.id as string),
      ).toBeUndefined();
      expect(
        await readdir(path.join(fixture.root, '.worktrees')).catch(() => []),
      ).toEqual([]);
      const worktreeLines = (
        await gitOutput(fixture.root, 'worktree', 'list', '--porcelain')
      )
        .split('\n')
        .filter((line) => line.startsWith('worktree '));
      expect(worktreeLines).toHaveLength(1);
      expect(worktreeLines[0]).toContain(fixture.root);
      expect(await gitOutput(fixture.root, 'branch', '--list', 'pi/*')).toBe(
        '',
      );
    } finally {
      await fixture.close();
    }
  });

  it('fails closed before merge when retained runtime cleanup rejects', async () => {
    const fixture = await isolatedServiceFixture();
    try {
      const repository = fixture.metadata.orchestration;
      await fixture.service.start();
      const created = (await fixture.service.createThread(fixture.projectId, {
        commandId: 'cleanup-failure-thread',
        title: 'Cleanup failure',
        prompt: 'Prepare for cleanup failure.',
      })) as { run: { id: string; checkoutId: string } };
      await waitFor(() => fixture.launches.length === 1);
      const run = repository.getRun(created.run.id) as { runtimeId: string };
      const checkoutPath = String(fixture.launches[0]?.checkoutCwd);
      fixture.service.onRegistryChange({
        kind: 'registered',
        snapshot: {
          ...runtimeHello(run.runtimeId),
          cwd: checkoutPath,
          session: { id: 'cleanup-failure-session', entries: [] },
        } as never,
      });
      await waitFor(
        () => repository.getRun(created.run.id)?.status === 'running',
      );
      await writeFile(path.join(checkoutPath, 'cleanup.txt'), 'branch\n');
      fixture.service.onRegistryChange({
        kind: 'event',
        runtimeId: run.runtimeId,
        event: {
          type: 'agent.settled',
          sessionId: 'cleanup-failure-session',
        },
        snapshot: {} as never,
      });
      await waitFor(
        () => repository.getRun(created.run.id)?.status === 'settled',
      );
      const mainHead = await gitOutput(fixture.root, 'rev-parse', 'HEAD');
      fixture.manager.stopRecovered.mockRejectedValueOnce(
        new Error('runtime cleanup failed'),
      );

      await expect(
        fixture.service.mergeCheckout(created.run.checkoutId, 'cleanup-merge'),
      ).rejects.toThrow('runtime cleanup failed');
      expect(await gitOutput(fixture.root, 'rev-parse', 'HEAD')).toBe(mainHead);
      expect(await gitOutput(fixture.root, 'show', 'HEAD:tracked.txt')).toBe(
        'base\n',
      );
      expect(repository.getCheckout(created.run.checkoutId)?.status).toBe(
        'dirty',
      );
      expect(
        repository.loadWorktreeRecord(created.run.checkoutId),
      ).toBeDefined();
      await expect(access(checkoutPath)).resolves.toBeUndefined();
      expect(repository.getCommandReceipt('cleanup-merge')).toBeUndefined();
      expect(fixture.manager.stopRecovered).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });

  it('reviews, merges, archives, retires, and preserves isolated lifecycle history', async () => {
    const fixture = await isolatedServiceFixture();
    try {
      const repository = fixture.metadata.orchestration;
      await fixture.service.start();
      const launchAndSettle = async (
        commandId: string,
        title: string,
        file: string,
        content: string,
        sessionId: string,
      ) => {
        const created = (await fixture.service.createThread(fixture.projectId, {
          commandId,
          title,
          prompt: title,
        })) as {
          thread: { id: string };
          run: { id: string; checkoutId: string };
        };
        const launchCount = fixture.launches.length;
        await waitFor(() => fixture.launches.length === launchCount + 1);
        const run = repository.getRun(created.run.id) as typeof created.run & {
          runtimeId: string;
        };
        const runtimeId = run.runtimeId;
        const checkoutPath = String(fixture.launches[launchCount]?.checkoutCwd);
        fixture.service.onRegistryChange({
          kind: 'registered',
          snapshot: {
            ...runtimeHello(runtimeId),
            cwd: checkoutPath,
            session: { id: sessionId, entries: [] },
          } as never,
        });
        await waitFor(
          () => repository.getRun(created.run.id)?.status === 'running',
        );
        await writeFile(path.join(checkoutPath, file), content);
        fixture.service.onRegistryChange({
          kind: 'event',
          runtimeId,
          event: { type: 'agent.settled', sessionId },
          snapshot: {} as never,
        });
        await waitFor(
          () => repository.getRun(created.run.id)?.status === 'settled',
        );
        return { ...created, checkoutPath, runtimeId };
      };

      const merged = await launchAndSettle(
        'lifecycle-merge-thread',
        'Merge lifecycle',
        'merged.txt',
        'merged\n',
        'lifecycle-session-1',
      );
      const review = (await fixture.service.reviewCheckout(
        merged.run.checkoutId,
      )) as {
        diff?: string;
      };
      expect(review.diff).toContain('merged.txt');
      const mergedResult = (await fixture.service.mergeCheckout(
        merged.run.checkoutId,
        'lifecycle-merge',
      )) as { checkout: { status: string } };
      expect(mergedResult.checkout.status).toBe('retired');
      expect(
        await readFile(path.join(fixture.root, 'merged.txt'), 'utf8'),
      ).toBe('merged\n');
      await expect(access(merged.checkoutPath)).rejects.toBeDefined();
      expect(
        repository.loadWorktreeRecord(merged.run.checkoutId),
      ).toBeUndefined();
      expect(fixture.manager.stopRecovered).toHaveBeenCalledTimes(1);
      expect(repository.getRun(merged.run.id)?.piSessionId).toBe(
        'lifecycle-session-1',
      );
      await fixture.service.archiveThread(
        merged.thread.id,
        'lifecycle-archive',
      );
      expect(repository.getThread(merged.thread.id)?.status).toBe('archived');
      expect(repository.getRun(merged.run.id)).toBeDefined();
      expect(repository.getRuntime(merged.runtimeId)).toBeDefined();

      const retired = await launchAndSettle(
        'lifecycle-retire-thread',
        'Retire lifecycle',
        'retired.txt',
        'retired\n',
        'lifecycle-session-2',
      );
      fixture.setLive(runtimeHello(retired.runtimeId));
      const liveStopCount = fixture.manager.stop.mock.calls.length;
      await fixture.service.retireCheckout(
        retired.run.checkoutId,
        'lifecycle-retire',
      );
      await expect(access(retired.checkoutPath)).rejects.toBeDefined();
      expect(repository.getCheckout(retired.run.checkoutId)?.status).toBe(
        'retired',
      );
      expect(
        repository.loadWorktreeRecord(retired.run.checkoutId),
      ).toBeUndefined();
      expect(fixture.manager.stop).toHaveBeenCalledTimes(liveStopCount + 1);
      expect(fixture.manager.stopRecovered).toHaveBeenCalledTimes(1);
      expect(repository.getThread(retired.thread.id)).toBeDefined();
      expect(repository.getRun(retired.run.id)).toBeDefined();

      const conflict = await launchAndSettle(
        'lifecycle-conflict-thread',
        'Conflict lifecycle',
        'conflict.txt',
        'branch\n',
        'lifecycle-session-3',
      );
      await writeFile(path.join(fixture.root, 'conflict.txt'), 'main\n');
      await git(fixture.root, 'add', 'conflict.txt');
      await git(fixture.root, 'commit', '-m', 'main conflict');
      await expect(
        fixture.service.mergeCheckout(
          conflict.run.checkoutId,
          'lifecycle-conflict',
        ),
      ).rejects.toMatchObject({ code: 'merge-conflict' });
      expect(repository.getCheckout(conflict.run.checkoutId)?.status).toBe(
        'dirty',
      );
      expect(
        repository.loadWorktreeRecord(conflict.run.checkoutId),
      ).toBeDefined();
      await expect(access(conflict.checkoutPath)).resolves.toBeUndefined();
      await expect(
        fixture.service.reviewCheckout(conflict.run.checkoutId),
      ).resolves.toBeDefined();
    } finally {
      await fixture.close();
    }
  });

  it('persists prompts before preparing distinct isolated WIP checkouts', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-orchestration-service-'),
    );
    const state = await mkdtemp(
      path.join(os.tmpdir(), 'pi-orchestration-state-'),
    );
    const metadata = new MetadataStore(path.join(state, 'dashboard.sqlite'));
    try {
      await git(root, 'init', '-b', 'main');
      await git(root, 'config', 'user.email', 'test@example.test');
      await git(root, 'config', 'user.name', 'Test');
      await writeFile(path.join(root, 'tracked.txt'), 'base\n');
      await git(root, 'add', '.');
      await git(root, 'commit', '-m', 'base');
      await writeFile(path.join(root, 'tracked.txt'), 'base\ncarried\n');
      await writeFile(path.join(root, 'untracked.txt'), 'also carried\n');

      const launches: Array<Record<string, unknown>> = [];
      const manager = {
        launch: vi.fn(async (input: Record<string, unknown>) => {
          launches.push(input);
          return { runtimeId: input.runtimeId as string };
        }),
        stop: vi.fn(async () => undefined),
        placement: () => undefined,
        recover: vi.fn(async () => false),
        sendInitialPromptOnce: vi.fn(),
      };
      const registry = {
        get: () => undefined,
        sendCommand: vi.fn(async () => ({ accepted: true })),
      };
      const service = new OrchestrationService({
        repository: metadata.orchestration,
        manager: manager as never,
        registry: registry as never,
        workspaces: () => [workspace(root)],
      });
      const adopted = (await service.adoptProject({
        commandId: 'adopt-once',
        rootPath: root,
        title: 'Repo',
        maxParallelRuns: 2,
      })) as { project: { id: string } };
      const first = (await service.createThread(adopted.project.id, {
        commandId: 'thread-one',
        title: 'One',
        prompt: 'complete prompt one',
      })) as { run: { id: string } };
      await service.createThread(adopted.project.id, {
        commandId: 'thread-two',
        title: 'Two',
        prompt: 'complete prompt two',
      });
      expect(metadata.orchestration.getRun(first.run.id)?.initialPrompt).toBe(
        'complete prompt one',
      );
      expect(launches).toHaveLength(0);

      await service.start();
      for (let i = 0; i < 100 && launches.length < 2; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (launches.length !== 2)
        throw new Error(
          JSON.stringify({
            launches,
            runs: metadata.orchestration.listRuns(),
            checkouts: metadata.orchestration.listCheckouts(),
          }),
        );
      const paths = launches.map((input) => String(input.checkoutCwd));
      expect(new Set(paths).size).toBe(2);
      expect(launches[0]).not.toHaveProperty('initialPrompt');
      expect(
        await readFile(path.join(paths[0] as string, 'untracked.txt'), 'utf8'),
      ).toBe('also carried\n');
      expect(
        await readFile(path.join(paths[1] as string, 'tracked.txt'), 'utf8'),
      ).toContain('carried');
      const runtimeId = metadata.orchestration.getRun(first.run.id)
        ?.runtimeId as string;
      service.onRegistryChange({
        kind: 'registered',
        snapshot: {
          runtimeId,
          ownership: 'managed',
          pid: 1,
          cwd: paths[0] as string,
          liveState: 'working',
          session: { id: 'pi-session-1', entries: [] },
          pendingInteractions: [],
          online: true,
        } as never,
      });
      for (let i = 0; i < 100; i += 1) {
        if (metadata.orchestration.getRun(first.run.id)?.status === 'running')
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const bound = metadata.orchestration.getRun(first.run.id);
      expect(registry.sendCommand).toHaveBeenCalledWith(
        runtimeId,
        expect.objectContaining({
          id: `run-prompt:${first.run.id}`,
          type: 'prompt',
          text: 'complete prompt one',
        }),
      );
      expect(
        metadata.orchestration.getCommandReceipt(`run-prompt:${first.run.id}`),
      ).toBeDefined();
      if (bound?.status !== 'running')
        throw new Error(
          JSON.stringify({
            bound,
            runtimes: metadata.orchestration.getRuntime(runtimeId),
          }),
        );
      service.onRegistryChange({
        kind: 'event',
        runtimeId,
        event: { type: 'agent.settled', sessionId: 'pi-session-1' },
        snapshot: {} as never,
      });
      for (let i = 0; i < 100; i += 1) {
        if (metadata.orchestration.getRun(first.run.id)?.status === 'settled')
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(metadata.orchestration.getRun(first.run.id)?.status).toBe(
        'settled',
      );
      await service.stop();
    } finally {
      metadata.close();
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });

  it('adopts a main checkout and linked worktree once under concurrent identity races', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-orchestration-adoption-'),
    );
    const linked = `${root}-linked`;
    const state = await mkdtemp(
      path.join(os.tmpdir(), 'pi-orchestration-adoption-state-'),
    );
    const file = path.join(state, 'dashboard.sqlite');
    const firstMetadata = new MetadataStore(file);
    const secondMetadata = new MetadataStore(file);
    const manager = {
      launch: vi.fn(async () => ({ runtimeId: 'unused' })),
      stop: vi.fn(async () => undefined),
      placement: () => undefined,
      recover: vi.fn(async () => false),
    };
    try {
      await git(root, 'init', '-b', 'main');
      await git(root, 'config', 'user.email', 'test@example.test');
      await git(root, 'config', 'user.name', 'Test');
      await writeFile(path.join(root, 'tracked.txt'), 'base\n');
      await git(root, 'add', '.');
      await git(root, 'commit', '-m', 'base');
      await git(root, 'worktree', 'add', '-b', 'linked', linked, 'HEAD');
      const first = new OrchestrationService({
        repository: firstMetadata.orchestration,
        manager: manager as never,
        registry: {
          get: () => undefined,
          sendCommand: vi.fn(async () => ({ accepted: true })),
        } as never,
        workspaces: () => [workspace(root)],
      });
      const second = new OrchestrationService({
        repository: secondMetadata.orchestration,
        manager: manager as never,
        registry: {
          get: () => undefined,
          sendCommand: vi.fn(async () => ({ accepted: true })),
        } as never,
        workspaces: () => [workspace(root)],
      });
      const results = await Promise.all([
        first.adoptProject({ commandId: 'adopt-main', rootPath: root }),
        second.adoptProject({ commandId: 'adopt-linked', rootPath: linked }),
      ]);
      const adopted = results as Array<{
        project: { id: string; repositoryIdentity?: string };
        checkout: { id: string; kind: string; path: string };
      }>;
      expect(adopted[0]?.project.id).toBe(adopted[1]?.project.id);
      expect(adopted[0]?.project.repositoryIdentity).toBe(
        adopted[1]?.project.repositoryIdentity,
      );
      expect(adopted[0]?.checkout.kind).toBe('main');
      expect(adopted[0]?.checkout.path).toBe(adopted[1]?.checkout.path);
      expect(firstMetadata.orchestration.listProjects()).toHaveLength(1);
      expect(firstMetadata.orchestration.listCheckouts()).toHaveLength(1);
      expect(
        firstMetadata.orchestration.getCommandReceipt('adopt-main'),
      ).toBeDefined();
      expect(
        firstMetadata.orchestration.getCommandReceipt('adopt-linked'),
      ).toBeDefined();
    } finally {
      firstMetadata.close();
      secondMetadata.close();
      await rm(linked, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });

  it('retries on the same worktree branch and preserves settled edits', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-orchestration-retry-'),
    );
    const state = await mkdtemp(
      path.join(os.tmpdir(), 'pi-orchestration-retry-state-'),
    );
    const metadata = new MetadataStore(path.join(state, 'dashboard.sqlite'));
    const launches: Array<Record<string, unknown>> = [];
    const manager = {
      launch: vi.fn(async (input: Record<string, unknown>) => {
        launches.push(input);
        return { runtimeId: input.runtimeId as string };
      }),
      stop: vi.fn(async () => undefined),
      placement: () => undefined,
      recover: vi.fn(async () => false),
      sendInitialPromptOnce: vi.fn(),
    };
    try {
      await git(root, 'init', '-b', 'main');
      await git(root, 'config', 'user.email', 'test@example.test');
      await git(root, 'config', 'user.name', 'Test');
      await writeFile(path.join(root, 'tracked.txt'), 'base\n');
      await git(root, 'add', '.');
      await git(root, 'commit', '-m', 'base');
      const service = new OrchestrationService({
        repository: metadata.orchestration,
        manager: manager as never,
        registry: {
          get: () => undefined,
          sendCommand: vi.fn(async () => ({ accepted: true })),
        } as never,
        workspaces: () => [workspace(root)],
        pollMs: 5,
      });
      const adopted = (await service.adoptProject({
        commandId: 'retry-adopt',
        rootPath: root,
      })) as { project: { id: string } };
      const created = (await service.createThread(adopted.project.id, {
        commandId: 'retry-thread',
        title: 'Retry task',
        prompt: 'Make the edit.',
      })) as { run: { id: string } };
      await service.start();
      for (let i = 0; i < 200 && launches.length < 1; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(launches).toHaveLength(1);
      const firstRun = metadata.orchestration.getRun(created.run.id);
      const firstRuntime = firstRun?.runtimeId as string;
      const firstPath = String(launches[0]?.checkoutCwd);
      const firstRecord = metadata.orchestration.loadWorktreeRecord(
        firstRun?.checkoutId as string,
      );
      expect(firstRecord).toBeDefined();
      await writeFile(path.join(firstPath, 'survives.txt'), 'partial edit\n');
      service.onRegistryChange({
        kind: 'registered',
        snapshot: {
          runtimeId: firstRuntime,
          ownership: 'managed',
          pid: 1,
          cwd: firstPath,
          liveState: 'working',
          session: { id: 'retry-session-1', entries: [] },
          pendingInteractions: [],
          online: true,
        } as never,
      });
      for (let i = 0; i < 100; i += 1) {
        if (metadata.orchestration.getRun(created.run.id)?.status === 'running')
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      service.onRegistryChange({
        kind: 'event',
        runtimeId: firstRuntime,
        event: { type: 'agent.settled', sessionId: 'retry-session-1' },
        snapshot: {} as never,
      });
      for (let i = 0; i < 100; i += 1) {
        if (metadata.orchestration.getRun(created.run.id)?.status === 'settled')
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const settledCheckout = metadata.orchestration.getCheckout(
        firstRun?.checkoutId as string,
      );
      const threadId = firstRun?.threadId;
      if (!threadId) throw new Error('The first run has no thread.');
      const retried = (await service.retry(threadId, {
        commandId: 'retry-command',
      })) as { run: { id: string; checkoutId: string; parentRunId?: string } };
      expect(retried.run.checkoutId).toBe(settledCheckout?.id);
      expect(retried.run.parentRunId).toBe(created.run.id);
      expect(await readFile(path.join(firstPath, 'survives.txt'), 'utf8')).toBe(
        'partial edit\n',
      );
      for (let i = 0; i < 200 && launches.length < 2; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(launches).toHaveLength(2);
      expect(launches[1]?.checkoutCwd).toBe(firstPath);
      const activeRecord = metadata.orchestration.loadWorktreeRecord(
        retried.run.checkoutId,
      );
      expect(activeRecord?.status).toBe('active');
      expect(Date.parse(activeRecord?.updatedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(firstRecord?.updatedAt ?? ''),
      );
      const secondRun = metadata.orchestration.getRun(retried.run.id);
      const secondRuntime = secondRun?.runtimeId as string;
      service.onRegistryChange({
        kind: 'registered',
        snapshot: {
          runtimeId: secondRuntime,
          ownership: 'managed',
          pid: 1,
          cwd: firstPath,
          liveState: 'working',
          session: { id: 'retry-session-2', entries: [] },
          pendingInteractions: [],
          online: true,
        } as never,
      });
      for (let i = 0; i < 100; i += 1) {
        if (metadata.orchestration.getRun(retried.run.id)?.status === 'running')
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      service.onRegistryChange({
        kind: 'event',
        runtimeId: secondRuntime,
        event: { type: 'agent.settled', sessionId: 'retry-session-2' },
        snapshot: {} as never,
      });
      for (let i = 0; i < 100; i += 1) {
        if (metadata.orchestration.getRun(retried.run.id)?.status === 'settled')
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const replay = await service.retry(threadId, {
        commandId: 'retry-command',
        prompt: 'Must not replace.',
      });
      expect(replay).toEqual(retried);
      await expect(
        service.createThread(adopted.project.id, {
          commandId: 'retry-command',
          title: 'Wrong command',
          prompt: 'Must fail.',
        }),
      ).rejects.toThrow('belongs to run.retry');
      await service.stop();
      const reopened = new MetadataStore(path.join(state, 'dashboard.sqlite'));
      try {
        expect(reopened.orchestration.listRuns(threadId)).toHaveLength(2);
        expect(
          reopened.orchestration.loadWorktreeRecord(retried.run.checkoutId)
            ?.branch,
        ).toBe(firstRecord?.branch);
        expect(
          reopened.orchestration.getCommandReceipt('retry-command'),
        ).toBeDefined();
      } finally {
        reopened.close();
      }
    } finally {
      metadata.close();
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });
});
