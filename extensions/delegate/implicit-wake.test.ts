import { describe, expect, test } from 'vitest';
import { registerImplicitAllSettledWake } from './implicit-wake';
import { DelegateJobManager } from './jobs';
import { createRun } from './types';
import { WakeCoordinator } from './wake-coordinator';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';

function activeOptions(logicalId: string) {
  return {
    logicalId,
    mode: 'single' as const,
    tasks: [logicalId],
    execute: async () => {
      const run = createRun(logicalId);
      run.state = 'success' as const;
      run.exitCode = 0;
      run.finishedAt = Date.now();
      return { runs: [run], handoff: `${logicalId} done` };
    },
  };
}

describe('registerImplicitAllSettledWake', () => {
  test('covers the active local cohort once and stays non-obstructive', async () => {
    const jobs = new DelegateJobManager();
    const workflow = new DelegateWorkflowCoordinator({
      jobs,
      ownerBranchId: 'branch-local',
    });
    workflow.schedule(activeOptions('one'));
    workflow.schedule(activeOptions('two'));
    const wakes = new WakeCoordinator({ workflow });

    const registered = registerImplicitAllSettledWake({
      workflow,
      wakes,
      ownerBranchId: 'branch-local',
    });
    expect(registered).toMatchObject({
      condition: { all: ['one@1', 'two@1'] },
      references: ['one@1', 'two@1'],
      nonObstructive: true,
      state: 'pending',
    });
    expect(
      registerImplicitAllSettledWake({
        workflow,
        wakes,
        ownerBranchId: 'branch-local',
      }),
    ).toBeUndefined();
    expect(wakes.list()).toHaveLength(1);

    wakes.dispose();
    await workflow.dispose();
    await jobs.dispose();
  });

  test('does not duplicate a persisted fallback after runtime restoration', async () => {
    const jobs = new DelegateJobManager();
    const workflow = new DelegateWorkflowCoordinator({
      jobs,
      ownerBranchId: 'branch-local',
    });
    workflow.schedule(activeOptions('restored'));
    const original = new WakeCoordinator({ workflow });
    registerImplicitAllSettledWake({
      workflow,
      wakes: original,
      ownerBranchId: 'branch-local',
    });
    const snapshot = original.snapshot();
    original.dispose();

    const restored = new WakeCoordinator({ workflow });
    expect(restored.restore(snapshot)).toBe(true);
    expect(
      registerImplicitAllSettledWake({
        workflow,
        wakes: restored,
        ownerBranchId: 'branch-local',
      }),
    ).toBeUndefined();
    expect(restored.list()).toHaveLength(1);

    restored.dispose();
    await workflow.dispose();
    await jobs.dispose();
  });

  test('is fully suppressed by an active explicit wake', async () => {
    const jobs = new DelegateJobManager();
    const workflow = new DelegateWorkflowCoordinator({
      jobs,
      ownerBranchId: 'branch-local',
    });
    workflow.schedule(activeOptions('covered'));
    workflow.schedule(activeOptions('other'));
    const wakes = new WakeCoordinator({ workflow });
    wakes.register({ id: 'explicit', condition: { node: 'covered' } });

    expect(
      registerImplicitAllSettledWake({
        workflow,
        wakes,
        ownerBranchId: 'branch-local',
      }),
    ).toBeUndefined();
    expect(wakes.list().map((wake) => wake.id)).toEqual(['explicit']);

    wakes.dispose();
    await workflow.dispose();
    await jobs.dispose();
  });
});
