import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { DelegateJobManager } from './jobs';
import { registerDelegateJobsTool } from './jobs-tool';
import { createRun } from './types';

interface Renderable {
  render: (width: number) => string[];
}

interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

interface RegisteredTool {
  description: string;
  promptGuidelines: string[];
  execute: (
    id: string,
    params: { action: 'list' | 'peek' | 'cancel'; id?: string },
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
  test('tells the agent to yield instead of peeking merely to wait', async () => {
    const manager = new DelegateJobManager();
    let tool: RegisteredTool | undefined;
    const pi = {
      registerTool(definition: RegisteredTool) {
        tool = definition;
      },
    } as unknown as ExtensionAPI;

    registerDelegateJobsTool(pi, manager);

    expect(tool?.description).toContain(
      'briefly tell the user you are waiting for the background delegate and will resume automatically, then end the turn',
    );
    expect(tool?.description).not.toContain(
      'if no independent work remains, end the turn',
    );
    expect(tool?.description).toContain('once when a bounded timeout changes');
    expect(tool?.promptGuidelines.join('\n')).toContain(
      'briefly tell the user you are waiting for the background delegate and will resume automatically, then end the turn',
    );
    expect(tool?.promptGuidelines.join('\n')).toContain(
      'Do not call delegate_jobs peek merely to wait or keep the turn open.',
    );
    expect(tool?.promptGuidelines.join('\n')).toContain(
      'never repeat it to poll',
    );
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
    registerDelegateJobsTool(pi, manager, undefined, () => automaticQueued);

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
      job: { id: started.id, handoff: expect.stringContaining(longTail) },
    });

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
