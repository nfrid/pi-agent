import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import continueExtension, {
  type AgentMessage,
  CONTINUE_CUSTOM_TYPE,
  canContinue,
  isIncompleteAssistant,
  prepareContinueContext,
} from './index';

function user(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 1,
  };
}

function assistant(
  stopReason: 'stop' | 'aborted' | 'error' | 'length' | 'toolUse',
  text = 'partial',
): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
  } as AgentMessage;
}

function toolResult(text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 3,
  };
}

function continueMarker(): AgentMessage {
  return {
    role: 'custom',
    customType: CONTINUE_CUSTOM_TYPE,
    content: [],
    display: false,
    timestamp: 4,
  };
}

describe('continue extension', () => {
  it('detects incomplete assistant turns', () => {
    expect(isIncompleteAssistant(assistant('aborted'))).toBe(true);
    expect(isIncompleteAssistant(assistant('error'))).toBe(true);
    expect(isIncompleteAssistant(assistant('length'))).toBe(true);
    expect(isIncompleteAssistant(assistant('toolUse'))).toBe(true);
    expect(isIncompleteAssistant(assistant('stop'))).toBe(false);
    expect(isIncompleteAssistant(user('hi'))).toBe(false);
  });

  it('strips continue markers and interrupted assistants before them', () => {
    expect(
      prepareContinueContext([
        user('do the thing'),
        assistant('aborted'),
        continueMarker(),
      ]),
    ).toEqual([user('do the thing')]);

    expect(
      prepareContinueContext([
        user('do the thing'),
        assistant('toolUse'),
        toolResult('ok'),
        continueMarker(),
      ]),
    ).toEqual([user('do the thing'), assistant('toolUse'), toolResult('ok')]);
  });

  it('allows continue after interruptions, not after a finished turn', () => {
    expect(canContinue([user('go'), assistant('aborted')])).toBe(true);
    expect(canContinue([user('go'), assistant('error')])).toBe(true);
    expect(
      canContinue([user('go'), assistant('toolUse'), toolResult('ok')]),
    ).toBe(true);
    expect(canContinue([user('go'), assistant('stop')])).toBe(false);
    expect(canContinue([])).toBe(false);
  });

  it('registers /continue and filters context when a marker is present', async () => {
    const commands = new Map<
      string,
      { handler: (args: string, ctx: unknown) => Promise<void> }
    >();
    let contextHandler:
      | ((event: { messages: AgentMessage[] }) => Promise<unknown>)
      | undefined;
    const sent: unknown[] = [];

    const pi = {
      registerCommand(name: string, options: { handler: () => Promise<void> }) {
        commands.set(name, options);
      },
      on(
        event: string,
        handler: (event: { messages: AgentMessage[] }) => Promise<unknown>,
      ) {
        if (event === 'context') contextHandler = handler;
      },
      sendMessage(message: unknown, options: unknown) {
        sent.push({ message, options });
      },
    } as unknown as ExtensionAPI;

    continueExtension(pi);

    expect(commands.has('continue')).toBe(true);
    expect(contextHandler).toBeTypeOf('function');

    const filtered = await contextHandler?.({
      messages: [user('go'), assistant('aborted'), continueMarker()],
    });
    expect(filtered).toEqual({ messages: [user('go')] });

    const untouched = await contextHandler?.({
      messages: [user('go'), assistant('stop')],
    });
    expect(untouched).toBeUndefined();

    const notices: string[] = [];
    const command = commands.get('continue');
    expect(command).toBeDefined();
    await command?.handler('', {
      isIdle: () => true,
      hasUI: true,
      ui: { notify: (message: string) => notices.push(message) },
      sessionManager: {
        getBranch: () => [
          {
            type: 'message',
            message: user('go'),
          },
          {
            type: 'message',
            message: assistant('aborted'),
          },
        ],
      },
    });

    expect(notices).toEqual([]);
    expect(sent).toEqual([
      {
        message: {
          customType: CONTINUE_CUSTOM_TYPE,
          content: [],
          display: false,
        },
        options: { triggerTurn: true },
      },
    ]);
  });
});
