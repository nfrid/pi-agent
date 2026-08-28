import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { registerDelegateGateTool } from './gate-tool';
import { WakeCoordinator } from './wake-coordinator';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';

function registeredTool(
  coordinator: WakeCoordinator,
  cancelled: string[] = [],
) {
  let tool!: {
    description: string;
    execute: (...args: unknown[]) => Promise<unknown>;
  };
  registerDelegateGateTool(
    {
      registerTool(value: unknown) {
        tool = value as typeof tool;
      },
    } as unknown as ExtensionAPI,
    () => coordinator,
    { onCancelled: (wake) => cancelled.push(wake.id) },
  );
  return tool;
}

describe('delegate_gate tool', () => {
  test('registers one all gate with safe delivery by default', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    workflow.schedule({
      logicalId: 'first',
      mode: 'single',
      tasks: ['first'],
      execute: async () => new Promise(() => {}),
    });
    workflow.schedule({
      logicalId: 'second',
      mode: 'single',
      tasks: ['second'],
      execute: async () => new Promise(() => {}),
    });
    const coordinator = new WakeCoordinator({ workflow });
    const tool = registeredTool(coordinator);
    const result = (await tool.execute(
      'call',
      { all: ['first', 'second'] },
      undefined,
      undefined,
      {} as ExtensionContext,
    )) as {
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
    };

    expect(tool.description).toContain(
      'Do not call this for any with safe delivery',
    );
    expect(result.content[0]?.text).toContain('all(first, second)');
    expect(result.details).toMatchObject({
      delivery: 'safe',
      references: ['first@1', 'second@1'],
    });
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]).toMatchObject({
      condition: { all: ['first@1', 'second@1'] },
      nonObstructive: false,
    });
  });

  test('an invalid replacement preserves the active gate', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    workflow.schedule({
      logicalId: 'first',
      mode: 'single',
      tasks: ['first'],
      execute: async () => new Promise(() => {}),
    });
    const coordinator = new WakeCoordinator({ workflow });
    const cancelled: string[] = [];
    const tool = registeredTool(coordinator, cancelled);
    await tool.execute('call', { all: ['first'] }, undefined, undefined, {});
    const original = coordinator.list()[0];

    await expect(
      tool.execute('call', { all: ['missing'] }, undefined, undefined, {}),
    ).rejects.toThrow('Unknown logical ID "missing"');
    expect(cancelled).toEqual([]);
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]?.id).toBe(original?.id);
  });

  test('a later gate replaces the active gate and idle maps to non-obstructive delivery', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    for (const id of ['first', 'second'])
      workflow.schedule({
        logicalId: id,
        mode: 'single',
        tasks: [id],
        execute: async () => new Promise(() => {}),
      });
    const coordinator = new WakeCoordinator({ workflow });
    const cancelled: string[] = [];
    const tool = registeredTool(coordinator, cancelled);
    await tool.execute(
      'call',
      { all: ['first', 'second'] },
      undefined,
      undefined,
      {},
    );
    await tool.execute(
      'call',
      { any: ['first', 'second'], delivery: 'idle' },
      undefined,
      undefined,
      {},
    );

    expect(cancelled).toHaveLength(1);
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]).toMatchObject({
      condition: { any: ['first@1', 'second@1'] },
      nonObstructive: true,
    });
  });
});
