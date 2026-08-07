import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('OrchestrationService', () => {
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
      const registry = { get: () => undefined };
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
        registry: { get: () => undefined } as never,
        workspaces: () => [workspace(root)],
      });
      const second = new OrchestrationService({
        repository: secondMetadata.orchestration,
        manager: manager as never,
        registry: { get: () => undefined } as never,
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
        registry: { get: () => undefined } as never,
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
