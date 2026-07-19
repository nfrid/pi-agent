import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import activityIndicator, {
  activityLabel,
  createToolBatch,
  THINKING_LABEL,
} from './index';

type Handler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => void;

function setup() {
  const handlers = new Map<string, Handler>();
  const registrations: string[] = [];
  const messages: Array<string | undefined> = [];
  const ctx = {
    hasUI: true,
    ui: { setWorkingMessage: (message?: string) => messages.push(message) },
  };
  const pi = {
    on(event: string, handler: Handler) {
      registrations.push(event);
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  activityIndicator(pi);
  return { ctx, handlers, messages, pi, registrations };
}

describe('activity indicator', () => {
  it('describes model phases, tool progress, and user input', () => {
    const batch = createToolBatch();
    expect(activityLabel(batch)).toBe(THINKING_LABEL);

    batch.phase = 'responding';
    expect(activityLabel(batch)).toBe('Responding...');
    batch.phase = 'preparing-tools';
    expect(activityLabel(batch)).toBe('Preparing tools...');

    batch.active.set('write-1', { name: 'write' });
    expect(activityLabel(batch)).toBe('Writing...');

    batch.active.set('edit-1', { name: 'edit' });
    expect(activityLabel(batch)).toBe('Waiting for tools (0/2)...');

    batch.active.delete('write-1');
    batch.completed++;
    expect(activityLabel(batch)).toBe('Editing (1/2)...');

    batch.active.set('question-1', { name: 'ask_user_question' });
    expect(activityLabel(batch)).toBe('Waiting for you...');
  });

  it.each([
    ['read', 'Reading...'],
    ['write', 'Writing...'],
    ['edit', 'Editing...'],
    ['bash', 'Running command...'],
    ['grep', 'Searching files...'],
    ['find', 'Finding files...'],
    ['ls', 'Listing files...'],
    ['web_search', 'Searching the web...'],
    ['fetch_content', 'Fetching pages...'],
    ['get_search_content', 'Retrieving search results...'],
    ['artifact_retrieve', 'Retrieving artifact...'],
    ['todo', 'Updating tasks...'],
  ])('uses an action label for %s', (name, expected) => {
    const batch = createToolBatch();
    batch.active.set('tool-1', { name });
    expect(activityLabel(batch)).toBe(expected);
  });

  it('holds a fast tool action through the next thinking section', () => {
    const { ctx, handlers, messages } = setup();
    handlers.get('turn_start')?.({}, ctx);
    handlers.get('tool_execution_start')?.(
      { toolCallId: 'grep-1', toolName: 'grep' },
      ctx,
    );
    handlers.get('tool_execution_end')?.({ toolCallId: 'grep-1' }, ctx);
    handlers.get('turn_start')?.({}, ctx);
    handlers.get('message_update')?.(
      { assistantMessageEvent: { type: 'thinking_start' } },
      ctx,
    );
    handlers.get('message_update')?.(
      { assistantMessageEvent: { type: 'thinking_start' } },
      ctx,
    );

    handlers.get('tool_execution_start')?.(
      { toolCallId: 'ls-1', toolName: 'ls' },
      ctx,
    );
    handlers.get('tool_execution_end')?.({ toolCallId: 'ls-1' }, ctx);
    handlers.get('turn_start')?.({}, ctx);
    handlers.get('message_update')?.(
      { assistantMessageEvent: { type: 'text_start' } },
      ctx,
    );

    expect(messages).toEqual([
      'Thinking...',
      'Searching files...',
      'Searching files...',
      'Searching files...',
      'Thinking...',
      'Listing files...',
      'Listing files...',
      'Listing files...',
      'Responding...',
    ]);
  });

  it('aggregates subagents within and across parallel delegate calls', () => {
    const { ctx, handlers, messages } = setup();
    handlers.get('turn_start')?.({}, ctx);
    handlers.get('tool_execution_start')?.(
      {
        toolCallId: 'delegate-many',
        toolName: 'delegate',
        args: { tasks: [{ task: 'one' }, { task: 'two' }, { task: 'three' }] },
      },
      ctx,
    );
    handlers.get('tool_execution_start')?.(
      {
        toolCallId: 'delegate-one',
        toolName: 'delegate',
        args: { task: 'four' },
      },
      ctx,
    );
    handlers.get('tool_execution_update')?.(
      {
        toolCallId: 'delegate-many',
        partialResult: {
          details: {
            runs: [
              { state: 'success', exitCode: 0 },
              { state: 'running', exitCode: -1 },
              { state: 'queued', exitCode: -1 },
            ],
          },
        },
      },
      ctx,
    );
    handlers.get('tool_execution_end')?.({ toolCallId: 'delegate-many' }, ctx);
    handlers.get('tool_execution_end')?.({ toolCallId: 'delegate-one' }, ctx);

    expect(messages).toEqual([
      'Thinking...',
      'Waiting for subagents (0/3)...',
      'Waiting for subagents (0/4)...',
      'Waiting for subagents (1/4)...',
      'Waiting for subagents (3/4)...',
      'Thinking...',
    ]);
  });

  it('updates from lifecycle events and registers only once', () => {
    const { ctx, handlers, messages, pi, registrations } = setup();
    activityIndicator(pi);
    expect(registrations).toHaveLength(8);

    handlers.get('session_start')?.({}, ctx);
    handlers.get('message_update')?.(
      { assistantMessageEvent: { type: 'text_start' } },
      ctx,
    );
    handlers.get('message_update')?.(
      {
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          partial: { content: [{ type: 'toolCall', name: 'read' }] },
        },
      },
      ctx,
    );
    handlers.get('tool_execution_start')?.(
      { toolCallId: 'one', toolName: 'read' },
      ctx,
    );
    handlers.get('tool_execution_end')?.({ toolCallId: 'one' }, ctx);
    handlers.get('session_shutdown')?.({}, ctx);

    expect(messages).toEqual([
      'Thinking...',
      'Responding...',
      'Reading...',
      'Reading...',
      'Reading...',
      undefined,
    ]);
  });
});
