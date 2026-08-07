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
});
