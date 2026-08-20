import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { createRun } from './types';
import { WakeCoordinator } from './wake-coordinator';
import { registerDelegateWakeTool } from './wake-tool';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';

describe('delegate_wake tool', () => {
  test('registers immediately and redacts payload evidence from status/list', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const attempt = workflow.schedule({
      logicalId: 'source',
      mode: 'single',
      tasks: ['source'],
      execute: async () => {
        const run = createRun('source');
        run.state = 'success';
        run.exitCode = 0;
        run.finishedAt = Date.now();
        return {
          runs: [run],
          handoff: 'secret evidence must not be returned by the tool',
        };
      },
    });
    await new Promise<void>((resolve) => {
      const check = () => {
        if (workflow.require(attempt.identity).settledAt !== undefined)
          resolve();
        else setTimeout(check, 0);
      };
      check();
    });
    const coordinator = new WakeCoordinator({ workflow });
    let tool!: { execute: (...args: unknown[]) => Promise<unknown> };
    const pi = {
      registerTool(value: unknown) {
        tool = value as typeof tool;
      },
    } as unknown as ExtensionAPI;
    registerDelegateWakeTool(pi, () => coordinator);
    const registered = (await tool.execute(
      'call',
      {
        action: 'subscribe',
        id: 'source-ready',
        condition: { node: attempt.identity },
        payload: ['handoff'],
        nonObstructive: true,
      },
      undefined,
      undefined,
      {} as ExtensionContext,
    )) as { content: Array<{ text: string }> };
    expect(registered.content[0]?.text).toContain('registered immediately');
    expect(JSON.stringify(registered)).not.toContain('secret evidence');
    const listed = (await tool.execute(
      'call',
      { action: 'list' },
      undefined,
      undefined,
      {} as ExtensionContext,
    )) as { details: { wakes: Array<{ payload: unknown }> } };
    expect(listed.details.wakes[0]).toMatchObject({
      payload: [{ kind: 'handoff' }],
      nonObstructive: true,
    });
    expect(JSON.stringify(listed)).not.toContain('secret evidence');
    await workflow.dispose();
  });

  test('supports explicit retry/recover and cancellation actions', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const coordinator = new WakeCoordinator({ workflow });
    let tool!: { execute: (...args: unknown[]) => Promise<unknown> };
    registerDelegateWakeTool(
      {
        registerTool(value: unknown) {
          tool = value as typeof tool;
        },
      } as unknown as ExtensionAPI,
      () => coordinator,
    );
    expect(() => coordinator.recover('missing')).toThrow();
    await expect(
      tool.execute(
        'call',
        { action: 'cancel', id: 'missing' },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toThrow('Unknown wake ID');
    await workflow.dispose();
  });
});
