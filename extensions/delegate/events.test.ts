import { describe, expect, test } from 'vitest';
import { processJsonLine } from './events';
import { createRun } from './types';

const assistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
};

describe('events', () => {
  test('does not duplicate agent_end messages received through message_end', () => {
    const run = createRun('test');
    expect(
      processJsonLine(
        JSON.stringify({ type: 'message_end', message: assistantMessage }),
        run,
      ),
    ).toBe(true);
    expect(
      processJsonLine(
        JSON.stringify({ type: 'agent_end', messages: [assistantMessage] }),
        run,
      ),
    ).toBe(false);
    expect(run.messages).toHaveLength(1);
    expect(run.usage.turns).toBe(1);
  });

  test('reconciles a partially missing message_end sequence at agent_end', () => {
    const run = createRun('test');
    processJsonLine(
      JSON.stringify({ type: 'message_end', message: assistantMessage }),
      run,
    );
    const recovered = {
      ...assistantMessage,
      timestamp: 2,
      content: [{ type: 'text', text: 'second turn' }],
    };
    expect(
      processJsonLine(
        JSON.stringify({
          type: 'agent_end',
          messages: [assistantMessage, recovered],
        }),
        run,
      ),
    ).toBe(true);
    expect(run.messages).toHaveLength(2);
    expect(run.usage).toMatchObject({ turns: 2 });
  });

  test('uses agent_end as a fallback when message_end events are absent', () => {
    const run = createRun('test');
    expect(
      processJsonLine(
        JSON.stringify({ type: 'agent_end', messages: [assistantMessage] }),
        run,
      ),
    ).toBe(true);
    expect(run.messages).toHaveLength(1);
    expect(run.usage.turns).toBe(1);
  });

  test('preserves detailed tool labels when end events omit args', () => {
    const run = createRun('inspect');
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'read-1',
        toolName: 'read',
        args: { path: '/tmp/project/file.ts' },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'contents' }] },
      }),
      run,
    );
    expect(run.activities[0]).toMatchObject({
      label: 'read /tmp/project/file.ts',
      status: 'completed',
    });
    expect(JSON.stringify(run)).not.toContain('contents');
  });

  test('does not stream tool output, thinking, or tool arguments to the parent', () => {
    const run = createRun('inspect');
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_update',
        toolCallId: 'read-1',
        toolName: 'read',
        partialResult: {
          content: [{ type: 'text', text: 'private-tool-output' }],
        },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'bash-1',
        toolName: 'bash',
        args: { command: 'private-command --with-input' },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'private-thinking',
        },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: 'private-tool-message' }],
        },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private-final-thinking' },
            {
              type: 'toolCall',
              id: 'secret-call',
              name: 'read',
              arguments: { path: 'private-path' },
            },
            { type: 'text', text: 'safe handoff' },
          ],
          usage: {},
        },
      }),
      run,
    );
    expect(run.activities.map((activity) => activity.label)).toEqual([
      'read',
      'bash',
      'thinking',
    ]);
    expect(run.activities[1]?.latestText).toBe('private-command --with-input');
    expect(run.activities[2]?.latestText).toBe('private-thinking');
    expect(run.activities[2]?.transcriptText).toBe('private-thinking');
    expect(run.messages).toHaveLength(1);
    expect(JSON.stringify(run)).not.toContain('private-');
    expect(JSON.stringify(run)).toContain('safe handoff');
  });

  test('previews the newest thinking paragraph instead of the whole block', () => {
    const run = createRun('think');
    const delta = (delta: string) =>
      processJsonLine(
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 0,
            delta,
          },
        }),
        run,
      );
    delta('Checking the widget layout.\n\n');
    delta('Now sizing ');
    delta('the columns.');

    expect(run.activities.at(-1)).toMatchObject({
      latestText: 'Now sizing the columns.',
      transcriptText: 'Checking the widget layout.\n\nNow sizing the columns.',
    });
  });

  test('keeps the tail of a long thinking block rather than its opening', () => {
    const run = createRun('think');
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: `${'opening filler. '.repeat(200)}\n\nthe freshest sentence.`,
        },
      }),
      run,
    );
    expect(run.activities.at(-1)?.latestText).toBe('the freshest sentence.');
  });

  test('starts a fresh preview for each consecutive thinking block', () => {
    const run = createRun('think');
    const send = (event: Record<string, unknown>) =>
      processJsonLine(
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: event,
        }),
        run,
      );
    send({ type: 'thinking_start', contentIndex: 0 });
    send({ type: 'thinking_delta', contentIndex: 0, delta: 'First block.' });
    send({
      type: 'thinking_end',
      contentIndex: 0,
      content: 'First block.',
    });
    send({ type: 'thinking_start', contentIndex: 0 });
    send({ type: 'thinking_delta', contentIndex: 0, delta: 'Second block.' });

    const thinking = run.activities.filter(
      (activity) => activity.type === 'thinking',
    );
    expect(thinking).toHaveLength(2);
    expect(thinking[0]).toMatchObject({
      status: 'completed',
      latestText: 'First block.',
    });
    expect(thinking[1]).toMatchObject({
      status: 'running',
      latestText: 'Second block.',
    });
  });

  test('recovers the final thinking content when deltas were missed', () => {
    const run = createRun('think');
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: 'Everything arrived at once.',
        },
      }),
      run,
    );
    expect(run.activities.at(-1)).toMatchObject({
      status: 'completed',
      latestText: 'Everything arrived at once.',
    });
  });
});
