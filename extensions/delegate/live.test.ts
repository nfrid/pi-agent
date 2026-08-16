import { describe, expect, it } from 'vitest';
import { processJsonLine } from './events';
import { delegateSurface } from './live';
import { DelegateStatusStore } from './status';
import { makeDetails } from './tool-result';
import { createRun } from './types';

describe('delegate live surface', () => {
  it('projects the current bounded status lineage for the renderer', () => {
    const store = new DelegateStatusStore();
    const run = createRun('inspect');
    const [id] = store.start([run], 'background');
    run.state = 'running';
    run.activities.push({
      type: 'tool',
      label: 'read source',
      status: 'running',
    });
    store.update(id, run);
    store.setPauseState(id, 'paused', 12_345);

    expect(delegateSurface(store)).toMatchObject({
      id: 'delegate.status',
      rendererId: 'delegate.status',
      placement: 'right-rail',
      viewModel: {
        version: 1,
        statuses: [
          {
            id,
            runId: run.runId,
            lineageId: id,
            name: 'Subagent',
            state: 'running',
            pauseState: 'paused',
            pausedAt: 12_345,
            activity: { label: 'read source' },
            transcript: [
              { type: 'task', label: 'Task', text: 'inspect' },
              { type: 'tool', label: 'read source' },
            ],
          },
        ],
      },
    });
  });

  it('projects logical workflow and wake metadata without workflow payloads', () => {
    const store = new DelegateStatusStore();
    const run = createRun('review');
    const [id] = store.start([run], 'background');
    store.setWorkflow(id, {
      attempt: { logicalId: 'review', ordinal: 1, identity: 'review@1' },
      logicalId: 'review',
      ordinal: 1,
      identity: 'review@1',
      dependencies: ['impl@1'],
      state: 'scheduled',
      createdAt: 1,
      scheduledAt: 1,
      reason: 'waiting for impl@1',
    } as never);
    store.setWakes([
      {
        id: 'review-ready',
        state: 'pending',
        references: ['review@1'],
        createdAt: 2,
      } as never,
    ]);

    const model = delegateSurface(store).viewModel as {
      statuses: Array<{ workflow?: unknown }>;
      wakes?: unknown[];
    };
    expect(model.statuses[0]?.workflow).toMatchObject({
      identity: 'review@1',
      state: 'scheduled',
      waitingFor: ['impl@1'],
    });
    expect(model.wakes).toMatchObject([
      { id: 'review-ready', state: 'pending', waitingFor: ['review@1'] },
    ]);
    expect(JSON.stringify(model.statuses[0]?.workflow)).not.toMatch(
      /handoff|report|payload|artifact|diagnostic|transcript/i,
    );
  });

  it('projects distinct bounded tool input and output to the dashboard', () => {
    const store = new DelegateStatusStore();
    const run = createRun('inspect');
    const [id] = store.start([run], 'background');
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'Checking the live path.',
        },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: 'Checking the live path.',
        },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'read-1',
        toolName: 'read',
        args: { path: 'src/live.ts' },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        toolName: 'read',
        result: { lines: 42 },
      }),
      run,
    );
    const details = makeDetails('single', [run]);
    expect(details.runs[0]?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'read',
          toolArguments: { path: 'src/live.ts' },
          toolResult: { lines: 42 },
        }),
      ]),
    );
    store.update(id, run);

    const viewModel = delegateSurface(store).viewModel as {
      statuses: Array<{ transcript?: unknown[] }>;
    };
    expect(viewModel.statuses[0]?.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          text: 'Checking the live path.',
        }),
        expect.objectContaining({
          type: 'tool',
          name: 'read',
          arguments: { path: 'src/live.ts' },
          result: { lines: 42 },
        }),
      ]),
    );
  });

  it('gives each active delegate an independent transcript budget and omits settled detail', () => {
    const store = new DelegateStatusStore();
    const makeRun = (task: string, state: 'running' | 'success') => {
      const run = createRun(task);
      run.state = state;
      run.activities = Array.from({ length: 8 }, (_, index) => ({
        type: 'tool' as const,
        id: `${task}-${index}`,
        label: 'x'.repeat(2_000),
        status: 'completed' as const,
      }));
      return run;
    };
    const first = makeRun('first', 'running');
    const second = makeRun('second', 'running');
    const activeRuns = [first, second];
    const [firstId, secondId] = store.start(activeRuns, 'background');
    store.update(firstId, first);
    store.update(secondId, second);
    const settled = makeRun('settled', 'success');
    const [settledId] = store.start([settled], 'background');
    store.update(settledId, settled);

    const statuses = (
      delegateSurface(store).viewModel as {
        statuses: Array<{
          state: string;
          transcript?: unknown[];
          transcriptTruncated?: boolean;
        }>;
      }
    ).statuses;
    const active = statuses.filter((status) => status.state === 'running');
    expect(active).toHaveLength(2);
    expect(
      active.every(
        (status) =>
          JSON.stringify(status.transcript).length > 14 * 1024 &&
          status.transcriptTruncated === true,
      ),
    ).toBe(true);
    expect(
      statuses.find((status) => status.state === 'success'),
    ).not.toMatchObject({ transcript: expect.anything() });
  });

  it('bounds aggregate structured values and validation errors on the dashboard surface', () => {
    const store = new DelegateStatusStore();
    const value = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [
        `field${index}`,
        'x'.repeat(4_096),
      ]),
    );
    for (const name of ['first', 'second']) {
      const run = createRun(name);
      run.state = 'success';
      run.structuredResult = {
        valid: true,
        value,
        errors: ['e'.repeat(500)],
      };
      const [id] = store.start([run], 'background');
      store.update(id, run);
    }

    const statuses = (
      delegateSurface(store).viewModel as {
        statuses: Array<{
          result?: {
            value?: unknown;
            valueOmitted?: boolean;
            errors?: string[];
          };
        }>;
      }
    ).statuses;
    expect(
      statuses.filter((status) => status.result?.value !== undefined),
    ).toHaveLength(0);
    expect(
      statuses.filter((status) => status.result?.valueOmitted),
    ).toHaveLength(2);
    expect(
      JSON.stringify(delegateSurface(store).viewModel).length,
    ).toBeLessThan(20 * 1024);
    expect(
      statuses.every((status) =>
        (status.result?.errors ?? []).every((error) => error.length <= 240),
      ),
    ).toBe(true);
  });

  it('prioritizes active work and bounds historical dashboard payloads', () => {
    const store = new DelegateStatusStore();
    const active = createRun('active task');
    const [activeId] = store.start([active], 'background');
    active.state = 'running';
    store.update(activeId, active);

    for (let index = 0; index < 30; index += 1) {
      const run = createRun(`historical task ${index}`);
      run.queuedAt = (active.queuedAt ?? 0) + index + 1;
      const [id] = store.start([run], 'background');
      run.state = 'success';
      run.finishedAt = Date.now() + index;
      store.update(id, run);
    }

    const statuses = (
      delegateSurface(store).viewModel as {
        statuses: Array<{ id: string; state: string }>;
      }
    ).statuses;
    expect(statuses).toHaveLength(24);
    expect(statuses[0]).toMatchObject({ id: activeId, state: 'running' });
    expect(statuses.some((status) => status.id === 'ds-2')).toBe(false);
  });
});
