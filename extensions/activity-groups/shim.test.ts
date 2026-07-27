import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installToolSequenceShim, type ShimHost } from './shim';
import type { SequenceRenderer, SequenceSnapshot } from './types';

/**
 * Stand-ins for Pi's interactive components, matching the shape the shim
 * patches: containers with a public `children` array, an assistant component
 * that tracks `hasToolCalls`, and a tool component with call/result state.
 */
class FakeContainer implements Component {
  children: Component[] = [];
  addChild(component: Component): void {
    this.children.push(component);
  }
  removeChild(component: Component): void {
    const index = this.children.indexOf(component);
    if (index >= 0) this.children.splice(index, 1);
  }
  clear(): void {
    this.children = [];
  }
  invalidate(): void {}
  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }
}

class FakeAssistant extends FakeContainer {
  lastMessage: AssistantMessage | undefined;
  hasToolCalls = false;
  updateContent(message: AssistantMessage): void {
    this.lastMessage = message;
    this.hasToolCalls = message.content.some(
      (content) => content.type === 'toolCall',
    );
  }
  override render(): string[] {
    const text = this.lastMessage?.content
      .map((content) =>
        content.type === 'text'
          ? content.text
          : content.type === 'thinking'
            ? content.thinking
            : '',
      )
      .join('');
    return [`assistant:${text ?? ''}`];
  }
}

class FakeTool extends FakeContainer {
  result: { isError: boolean } | undefined;
  isPartial = true;
  executionStarted = false;
  ui = { requestRender: () => {} };
  constructor(
    public toolName: string,
    public toolCallId: string,
    public args: unknown,
    public cwd = '/repo',
  ) {
    super();
  }
  markExecutionStarted(): void {
    this.executionStarted = true;
  }
  updateResult(result: { isError: boolean }): void {
    this.result = result;
    this.isPartial = false;
  }
  override render(): string[] {
    return [`tool:${this.toolName}`];
  }
}

class FakeOther extends FakeContainer {
  override render(): string[] {
    return ['other'];
  }
}

function assistantMessage(
  content: AssistantMessage['content'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
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
    stopReason: 'toolUse',
    timestamp: 0,
  };
}

function toolCallMessage(id: string, name: string): AssistantMessage {
  return assistantMessage([
    // Narration lives in thinking: in this repo's session logs 2616 of 2861
    // tool-carrying messages narrate that way and only 10 also speak to the
    // user, which is why thinking is what a group may hide.
    { type: 'thinking', thinking: 'Reading the auth code' },
    { type: 'toolCall', id, name, arguments: {} },
  ]);
}

const theme = { fg: (_color: string, text: string) => text } as Theme;

/** Records what the renderer was handed and prints a one-line summary. */
function recordingRenderer(): {
  renderer: SequenceRenderer;
  snapshots: SequenceSnapshot[];
  streamingFlags: boolean[];
} {
  const snapshots: SequenceSnapshot[] = [];
  const streamingFlags: boolean[] = [];
  const renderer: SequenceRenderer = (sequence, options) => {
    snapshots.push(sequence);
    streamingFlags.push(options.streaming);
    return {
      invalidate: () => {},
      render: (width: number) => [
        `group:${sequence.id}:${sequence.items.length}:${options.streaming ? 'live' : 'done'}`,
        ...(options.expanded ? options.defaultView.render(width) : []),
      ],
    };
  };
  return { renderer, snapshots, streamingFlags };
}

interface Harness {
  chat: FakeContainer;
  host: ShimHost;
  setBusy(busy: boolean): void;
  setExpanded(expanded: boolean): void;
  advance(ms: number): void;
  render(): string[];
}

let uninstall: (() => void) | undefined;

function harness(overrides: Partial<ShimHost> = {}): Harness {
  const chat = new FakeContainer();
  let busy = true;
  let expanded = false;
  let clock = 1000;
  const host: ShimHost = {
    assistantComponent: FakeAssistant as never,
    toolComponent: FakeTool as never,
    container: FakeContainer as never,
    getTheme: () => theme,
    isBusy: () => busy,
    isExpanded: () => expanded,
    requestRender: () => {},
    now: () => clock,
    ...overrides,
  };
  return {
    chat,
    host,
    setBusy: (value) => {
      busy = value;
    },
    setExpanded: (value) => {
      expanded = value;
    },
    advance: (ms) => {
      clock += ms;
    },
    render: () => chat.render(80),
  };
}

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe('tool sequence shim', () => {
  it('collapses an assistant message and its tool calls into one sequence', () => {
    const { renderer, snapshots } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    const assistant = new FakeAssistant();
    h.chat.addChild(assistant);
    assistant.updateContent(toolCallMessage('call-1', 'read'));
    const tool = new FakeTool('read', 'call-1', { path: 'src/auth.ts' });
    h.chat.addChild(tool);
    tool.markExecutionStarted();

    expect(h.render()).toEqual(['group:group-1:2:live']);
    const [snapshot] = snapshots;
    expect(snapshot?.items).toEqual([
      expect.objectContaining({ type: 'assistant', provisional: false }),
      expect.objectContaining({
        type: 'tool',
        id: 'call-1',
        name: 'read',
        status: 'running',
        isError: false,
      }),
    ]);
    expect(snapshot?.cwd).toBe('/repo');
  });

  it('leaves ungrouped components alone and closes a sequence on a plain answer', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    const other = new FakeOther();
    h.chat.addChild(other);
    const assistant = new FakeAssistant();
    h.chat.addChild(assistant);
    assistant.updateContent(toolCallMessage('call-1', 'read'));
    h.chat.addChild(new FakeTool('read', 'call-1', {}));
    const answer = new FakeAssistant();
    h.chat.addChild(answer);
    answer.updateContent(assistantMessage([{ type: 'text', text: 'Done' }]));

    // The answer joins the group it concludes, so its narration counts
    // towards the title, and closes it — the checkmark lands as soon as the
    // model starts talking rather than waiting for the run to end.
    expect(h.render()).toEqual([
      'other',
      'group:group-1:3:done',
      'assistant:Done',
    ]);
  });

  it('starts a new sequence when the work changes character', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    const first = new FakeAssistant();
    h.chat.addChild(first);
    first.updateContent(toolCallMessage('call-1', 'read'));
    h.chat.addChild(new FakeTool('read', 'call-1', {}));
    const second = new FakeAssistant();
    h.chat.addChild(second);
    second.updateContent(toolCallMessage('call-2', 'edit'));
    h.chat.addChild(new FakeTool('edit', 'call-2', {}));

    expect(h.render()).toEqual([
      'group:group-1:2:done',
      'group:group-2:2:live',
    ]);
  });

  /** Append a model turn: one assistant message plus the tools it called. */
  function turn(
    h: Harness,
    tools: { name: string; args?: unknown }[],
    prefix = 't',
  ): FakeTool[] {
    const assistant = new FakeAssistant();
    h.chat.addChild(assistant);
    assistant.updateContent(
      assistantMessage(
        tools.map((tool, index) => ({
          type: 'toolCall' as const,
          id: `${prefix}-${index}`,
          name: tool.name,
          arguments: {},
        })),
      ),
    );
    return tools.map((tool, index) => {
      const component = new FakeTool(
        tool.name,
        `${prefix}-${index}`,
        tool.args ?? {},
      );
      h.chat.addChild(component);
      return component;
    });
  }

  it('merges consecutive turns of the same kind into one sequence', () => {
    const { renderer, snapshots } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    turn(h, [{ name: 'read' }, { name: 'read' }], 'a');
    turn(h, [{ name: 'grep' }], 'b');
    turn(h, [{ name: 'read' }], 'c');

    // Three turns of exploration read as one phase, not three groups.
    expect(h.render()).toEqual(['group:group-1:7:live']);
    expect(
      snapshots.at(-1)?.items.filter((item) => item.type === 'tool'),
    ).toHaveLength(4);
  });

  it('splits when editing begins but absorbs reads back into the edit', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    turn(h, [{ name: 'read' }], 'a');
    turn(h, [{ name: 'edit' }], 'b');
    // Looking something up mid-edit is not a new phase.
    turn(h, [{ name: 'read' }], 'c');
    turn(h, [{ name: 'edit' }], 'd');

    expect(h.render()).toEqual([
      'group:group-1:2:done',
      'group:group-2:6:live',
    ]);
  });

  it('keeps an edit and check loop in one sequence', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    turn(h, [{ name: 'edit' }], 'a');
    turn(h, [{ name: 'bash', args: { command: 'npm test' } }], 'b');
    turn(h, [{ name: 'edit' }], 'c');
    turn(h, [{ name: 'bash', args: { command: 'npm test' } }], 'd');

    // Making a change work is one activity, however many times it loops.
    expect(h.render()).toEqual(['group:group-1:8:live']);
  });

  it('starts a new sequence when exploration turns into editing', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    turn(h, [{ name: 'read' }], 'a');
    turn(h, [{ name: 'bash', args: { command: 'git status' } }], 'b');
    turn(h, [{ name: 'edit' }], 'c');

    // Shell commands stay connective tissue; the first edit is the boundary.
    expect(h.render()).toEqual([
      'group:group-1:4:done',
      'group:group-2:2:live',
    ]);
  });

  it('caps a long run so one group cannot swallow the transcript', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    for (let index = 0; index < 30; index += 1)
      turn(h, [{ name: 'read' }], `t${index}`);

    // 30 reads are several times MAX_GROUP_CALLS, so they land in chunks.
    expect(h.render()).toEqual([
      'group:group-1:24:done',
      'group:group-2:24:done',
      'group:group-3:12:live',
    ]);
  });

  it('shows what the model said and ends the group it was narrating', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    turn(h, [{ name: 'read' }], 'a');
    const commentary = new FakeAssistant();
    h.chat.addChild(commentary);
    commentary.updateContent(
      assistantMessage([
        { type: 'text', text: 'The leak is in the shutdown path.' },
        { type: 'toolCall', id: 'b-0', name: 'edit', arguments: {} },
      ]),
    );
    const edit = new FakeTool('edit', 'b-0', {});
    h.chat.addChild(edit);

    // The commentary renders in full even though it carried a tool call, and
    // the work that follows it is a new group led by the tool itself.
    expect(h.render()).toEqual([
      'group:group-1:3:done',
      'assistant:The leak is in the shutdown path.',
      'group:group-2:1:live',
    ]);
  });

  it('never revives a group that has already finished', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    turn(h, [{ name: 'read' }], 'a');
    // The request ends and the group renders its checkmark.
    h.setBusy(false);
    expect(h.render()).toEqual(['group:group-1:2:done']);

    // More work arrives. It would merge by phase, but the finished group is
    // sealed, so it opens a new one rather than coming back to life.
    h.setBusy(true);
    turn(h, [{ name: 'read' }], 'b');
    expect(h.render()).toEqual([
      'group:group-1:2:done',
      'group:group-2:2:live',
    ]);
  });

  it('ends a build once it goes back to looking around', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    turn(h, [{ name: 'edit' }], 'a');
    // A couple of lookups belong to the edit that prompted them.
    turn(h, [{ name: 'read' }, { name: 'read' }], 'b');
    expect(h.render()).toEqual(['group:group-1:5:live']);

    // A sustained run of them is the agent off finding something else out.
    turn(h, [{ name: 'read' }, { name: 'grep' }, { name: 'read' }], 'c');
    expect(h.render()).toEqual([
      'group:group-1:5:done',
      'group:group-2:4:live',
    ]);
  });

  it('stamps a duration once the tail sequence stops streaming', () => {
    const { renderer, snapshots } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    const assistant = new FakeAssistant();
    h.chat.addChild(assistant);
    assistant.updateContent(toolCallMessage('call-1', 'read'));
    const tool = new FakeTool('read', 'call-1', {});
    h.chat.addChild(tool);
    h.render();

    h.advance(1500);
    tool.updateResult({ isError: false });
    h.setBusy(false);
    expect(h.render()).toEqual(['group:group-1:2:done']);

    const last = snapshots.at(-1);
    expect(last?.startedAt).toBe(1000);
    expect(last?.completedAt).toBe(2500);
    expect(last?.items.at(-1)).toMatchObject({ status: 'complete' });
  });

  it('reports failures and omits timing for sequences replayed from history', () => {
    const { renderer, snapshots } = recordingRenderer();
    const h = harness();
    h.setBusy(false);
    uninstall = installToolSequenceShim(renderer, h.host);

    const assistant = new FakeAssistant();
    h.chat.addChild(assistant);
    assistant.updateContent(toolCallMessage('call-1', 'read'));
    const tool = new FakeTool('read', 'call-1', {});
    tool.updateResult({ isError: true });
    h.chat.addChild(tool);

    expect(h.render()).toEqual(['group:group-1:2:done']);
    expect(snapshots.at(-1)).toMatchObject({ failed: true });
    expect(snapshots.at(-1)?.completedAt).toBeUndefined();
  });

  it('replays the original components when expanded', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    h.setExpanded(true);
    uninstall = installToolSequenceShim(renderer, h.host);

    const assistant = new FakeAssistant();
    h.chat.addChild(assistant);
    assistant.updateContent(toolCallMessage('call-1', 'read'));
    h.chat.addChild(new FakeTool('read', 'call-1', {}));

    expect(h.render()).toEqual([
      'group:group-1:2:live',
      'assistant:Reading the auth code',
      'tool:read',
    ]);
  });

  it('costs one group when the renderer throws, not the whole feature', () => {
    const onError = vi.fn();
    const onWarn = vi.fn();
    const h = harness({ onError, onWarn });
    uninstall = installToolSequenceShim(() => {
      throw new Error('boom');
    }, h.host);

    turn(h, [{ name: 'read' }], 'a');
    // The broken group shows Pi's own rendering; grouping stays installed.
    expect(h.render()).toEqual(['assistant:', 'tool:read']);
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(FakeTool.prototype.render.name).toBe('patchedToolRender');
  });

  it('gives up once the faults keep coming', () => {
    const onError = vi.fn();
    const onWarn = vi.fn();
    const h = harness({ onError, onWarn });
    uninstall = installToolSequenceShim(() => {
      throw new Error('boom');
    }, h.host);

    // Each new group fails in turn; the third is one too many.
    for (let index = 0; index < 3; index += 1) {
      turn(h, [{ name: 'edit' }], `e${index}`);
      turn(
        h,
        [{ name: 'read' }, { name: 'read' }, { name: 'read' }],
        `r${index}`,
      );
      h.render();
    }

    expect(onError).toHaveBeenCalledOnce();
    // Stock rendering from here on, and the patches are gone.
    expect(FakeTool.prototype.render.name).toBe('render');
  });

  it('restores every patched method on uninstall', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    const originals = {
      assistantRender: FakeAssistant.prototype.render,
      toolRender: FakeTool.prototype.render,
      updateContent: FakeAssistant.prototype.updateContent,
      addChild: FakeContainer.prototype.addChild,
      removeChild: FakeContainer.prototype.removeChild,
      clear: FakeContainer.prototype.clear,
    };
    const stop = installToolSequenceShim(renderer, h.host);
    expect(FakeContainer.prototype.addChild).not.toBe(originals.addChild);
    stop();

    expect(FakeAssistant.prototype.render).toBe(originals.assistantRender);
    expect(FakeTool.prototype.render).toBe(originals.toolRender);
    expect(FakeAssistant.prototype.updateContent).toBe(originals.updateContent);
    expect(FakeContainer.prototype.addChild).toBe(originals.addChild);
    expect(FakeContainer.prototype.removeChild).toBe(originals.removeChild);
    expect(FakeContainer.prototype.clear).toBe(originals.clear);
  });
});
