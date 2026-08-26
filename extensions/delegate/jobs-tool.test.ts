import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { DelegateJobManager } from './jobs';
import { registerDelegateJobsTool } from './jobs-tool';
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
      action: 'list' | 'status' | 'peek' | 'feedback' | 'cancel';
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
    expect(actionDescription).not.toContain('peek');
    expect(actionDescription).toContain('feedback sends one correction');
    expect(actionDescription).toContain('cancel stops work');
    expect(tool?.description).not.toContain('Actions:');
    expect(tool?.promptGuidelines).toBeUndefined();
    expect(tool?.description).not.toContain('peek');
    await manager.dispose();
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
