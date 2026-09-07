import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, test, vi } from 'vitest';
import { DelegateJobManager } from './jobs';
import { registerDelegateJobsTool } from './jobs-tool';
import type { DelegateStatusSnapshot } from './status';
import { createRun } from './types';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';

interface Renderable {
  render: (width: number) => string[];
}

interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

interface RegisteredTool {
  description: string;
  promptGuidelines?: string[];
  parameters: {
    properties?: {
      action?: { description?: string };
    };
  };
  execute: (
    id: string,
    params: {
      action: 'list' | 'status' | 'inspect' | 'peek' | 'feedback' | 'cancel';
      id?: string;
      message?: string;
    },
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
  renderCall: (
    args: Record<string, unknown>,
    theme: ThemeLike,
    context: { expanded: boolean },
  ) => Renderable;
  renderResult: (
    result: {
      content: Array<{ type: string; text: string }>;
      details?: Record<string, unknown>;
    },
    options: { expanded: boolean },
    theme: ThemeLike,
  ) => Renderable;
}

const theme: ThemeLike = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `**${text}**`,
};

describe('delegate_jobs rendering', () => {
  test('keeps job mechanics in the description and workflow guidance concise', async () => {
    const manager = new DelegateJobManager();
    let tool: RegisteredTool | undefined;
    const pi = {
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
    } as unknown as ExtensionAPI;

    registerDelegateJobsTool(pi, manager);

    expect(tool?.description).toContain('eagerly unless held by delegate_gate');
    expect(tool?.description).toContain(
      'Never use list/status repeatedly or pair them with sleeps',
    );
    const actionDescription = tool?.parameters.properties?.action?.description;
    expect(actionDescription).toContain('list shows tracked work once');
    expect(actionDescription).toContain(
      'status supports a one-time operational decision',
    );
    expect(actionDescription).toContain(
      'inspect shows bounded live activity only when it may change steering',
    );
    expect(actionDescription).not.toContain('peek');
    expect(actionDescription).toContain('feedback sends one correction');
    expect(actionDescription).toContain('cancel stops work');
    expect(tool?.description).not.toContain('Actions:');
    expect(tool?.promptGuidelines).toBeUndefined();
    expect(tool?.description).not.toContain('peek');
    await manager.dispose();
  });

  test('resolves inspect through active workflow/status getters without side effects', async () => {
    const get = vi.fn(() => ({
      id: 'job-1',
      name: 'worker',
      mode: 'single' as const,
      state: 'running' as const,
      tasks: ['task'],
      createdAt: 100,
      startedAt: 110,
      runs: [],
    }));
    const sendFeedback = vi.fn();
    const cancel = vi.fn();
    const manager = {
      get,
      sendFeedback,
      cancel,
      list: vi.fn(),
      peek: vi.fn(),
      materialize: vi.fn(),
    } as unknown as DelegateJobManager;
    const attempt = {
      identity: 'impl@1',
      logicalId: 'impl',
      state: 'running',
      jobId: 'job-1',
      dependencies: [],
      waitingFor: [],
      inputs: [],
      createdAt: 100,
      scheduledAt: 100,
      startedAt: 110,
      attempt: { logicalId: 'impl', ordinal: 1, identity: 'impl@1' },
    } as never;
    const liveStatus = {
      id: 'ds-1',
      runId: 'run-1',
      lineageId: 'lineage-1',
      name: 'worker',
      kind: 'background',
      state: 'running',
      allowWrites: false,
      createdAt: 100,
      runCount: 1,
      transcript: [
        {
          id: 'progress',
          type: 'assistant',
          label: 'Response',
          text: 'checking implementation',
          status: 'completed',
          at: 120,
          run: 1,
        },
      ],
      workflow: { identity: 'impl@1' },
    } as unknown as DelegateStatusSnapshot;
    const workflow = { get: vi.fn(() => attempt) };
    const statuses = { list: vi.fn(() => [liveStatus]) };
    let tool: RegisteredTool | undefined;
    const pi = {
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
    } as unknown as ExtensionAPI;
    registerDelegateJobsTool(
      pi,
      manager,
      undefined,
      undefined,
      undefined,
      () => workflow as never,
      () => statuses as never,
    );

    const result = await tool?.execute('inspect', {
      action: 'inspect',
      id: 'impl',
    });
    expect(result?.content[0]?.text).toContain('checking implementation');
    expect(result?.details).toMatchObject({
      action: 'inspect',
      inspect: { workflowIdentity: 'impl@1', jobId: 'job-1' },
    });
    expect(statuses.list).toHaveBeenCalledOnce();
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(
      (manager as unknown as { materialize: ReturnType<typeof vi.fn> })
        .materialize,
    ).not.toHaveBeenCalled();
  });

  test('returns bounded workflow failure reasons without result bodies', async () => {
    const manager = new DelegateJobManager();
    const workflow = new DelegateWorkflowCoordinator({ jobs: manager });
    let tool: RegisteredTool | undefined;
    const pi = {
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
    } as unknown as ExtensionAPI;
    registerDelegateJobsTool(pi, manager, undefined, undefined, workflow);

    const settled = new Promise<void>((resolve) => {
      workflow.subscribeTerminal(() => resolve());
    });
    workflow.schedule({
      logicalId: 'child',
      prepare: async () => {
        throw new Error('Required symbolic report is unavailable.');
      },
    });
    await settled;

    const status = await tool?.execute('call-status', {
      action: 'status',
      id: 'child',
    });
    expect(status?.content[0]?.text).toContain(
      'Required symbolic report is unavailable.',
    );
    expect(status?.content[0]?.text).toContain(
      'Do not wait, sleep, or call status again',
    );
    expect(status?.details).toMatchObject({
      attempt: {
        identity: 'child@1',
        state: 'error',
        reason: 'Required symbolic report is unavailable.',
      },
    });
    await manager.dispose();
  });

  test('uses colored compact previews and preserves full expanded output', async () => {
    const manager = new DelegateJobManager();
    const longTail = `END-${'x'.repeat(300)}`;
    const run = createRun('inspect rendering');
    run.exitCode = 0;
    run.state = 'success';
    run.messages = [
      {
        role: 'assistant',
        api: 'openai-responses',
        provider: 'test',
        model: 'test',
        content: [{ type: 'text', text: 'done' }],
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
    ];
    let tool: RegisteredTool | undefined;
    const pi = {
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
    } as unknown as ExtensionAPI;
    let automaticQueued = true;
    registerDelegateJobsTool(pi, manager, undefined, () =>
      automaticQueued ? 'queued' : undefined,
    );

    const started = manager.start({
      mode: 'single',
      tasks: ['inspect rendering'],
      execute: async () => ({
        runs: [run],
        handoff: `Useful result ${longTail}`,
      }),
    });
    await manager.peek(started.id, 1_000);
    const suppressed = await tool?.execute('call-queued', {
      action: 'peek',
      id: started.id,
    });
    expect(suppressed?.content[0]?.text).toContain('already queued');
    expect(suppressed?.details).toMatchObject({
      delivery: 'automatic-queued',
      job: { id: started.id },
    });
    expect(JSON.stringify(suppressed?.details)).not.toContain(longTail);

    automaticQueued = false;
    const result = await tool?.execute('call-1', {
      action: 'peek',
      id: started.id,
    });
    expect(result).toBeDefined();
    if (!tool || !result)
      throw new Error('delegate_jobs tool was not captured');

    const compact = tool
      .renderResult(result, { expanded: false }, theme)
      .render(160)
      .join('\n');
    const expanded = tool
      .renderResult(result, { expanded: true }, theme)
      .render(500)
      .join('\n');
    expect(compact).toContain('<success>✓ dj-1 success</success>');
    expect(compact).toContain('…');
    expect(compact).not.toContain(longTail);
    expect(expanded).toContain(longTail);

    const partialCall = tool
      .renderCall({}, theme, { expanded: false })
      .render(120)
      .join('\n');
    expect(partialCall).toContain('delegate_jobs');
    await manager.dispose();
  });
});
