import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installToolSequenceShim, type ShimHost } from './shim';
import { headersOf } from './title';
import type { SequenceRenderer, SequenceSnapshot } from './types';

/**
 * Stand-ins for Pi's interactive components, matching the shape the shim
 * patches: containers with a public `children` array, an assistant component
 * holding its last message, and a tool component with call/result state.
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
  updateContent(message: AssistantMessage): void {
    this.lastMessage = message;
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
    // Narration lives in thinking: as of July 2026, 2616 of this repo's 2861
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
      expect.objectContaining({ type: 'assistant' }),
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

    // The answer stands outside the work it reports on and Pi renders it as
    // it always has, but it still ends the group: the checkmark lands as soon
    // as the model starts talking rather than waiting for the run to end.
    expect(h.render()).toEqual([
      'other',
      'group:group-1:2:done',
      'assistant:Done',
    ]);
  });

  it('reads a header written as text as narration, not as an answer', () => {
    const { renderer, snapshots } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    // Codex-family models put the header on the text channel. Taken as speech
    // it would close the group on every turn, leaving one call in each.
    const first = new FakeAssistant();
    h.chat.addChild(first);
    first.updateContent(
      assistantMessage([
        { type: 'text', text: '**Reading the auth code**' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
      ]),
    );
    h.chat.addChild(new FakeTool('read', 'call-1', {}));
    const second = new FakeAssistant();
    h.chat.addChild(second);
    second.updateContent(
      assistantMessage([
        { type: 'text', text: '**Reading the session store**' },
        { type: 'toolCall', id: 'call-2', name: 'read', arguments: {} },
      ]),
    );
    h.chat.addChild(new FakeTool('read', 'call-2', {}));

    // One group, and no line of its own for either header.
    expect(h.render()).toEqual(['group:group-1:4:live']);
    // Both headers stayed inside it; the renderer uses the latest useful one.
    expect(
      snapshots
        .at(-1)
        ?.items.flatMap((item) =>
          item.type === 'assistant' ? headersOf(item.message) : [],
        ),
    ).toEqual(['Reading the auth code', 'Reading the session store']);
  });

  /**
   * Where the boundaries fall is `grouping.test.ts`'s subject; what this proves
   * is the wiring — that the components are read into a transcript the grouper
   * can split, and that a split comes back out as two rendered groups.
   */
  it('renders a grouping boundary as two sequences', () => {
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

  it('lets a preamble lead the work it announced', () => {
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

    // The commentary ends the group above it and leads the one below, whose
    // title it becomes — so it is printed once, on the group's own line.
    expect(h.render()).toEqual([
      'group:group-1:2:done',
      'group:group-2:2:live',
    ]);
  });

  it('does not flash grouped thinking while a preamble awaits its tool call', () => {
    const { renderer } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    const assistant = new FakeAssistant();
    h.chat.addChild(assistant);
    assistant.updateContent(
      assistantMessage([
        { type: 'thinking', thinking: 'First private step.' },
        { type: 'thinking', thinking: 'Second private step.' },
      ]),
    );
    expect(h.render()).toEqual(['group:group-1:1:live']);

    // Text streams before the toolCall content block. It is temporarily plain
    // speech, but the thinking already represented by the live group must not
    // burst back into the transcript during that gap.
    assistant.updateContent(
      assistantMessage([
        { type: 'thinking', thinking: 'First private step.' },
        { type: 'thinking', thinking: 'Second private step.' },
        { type: 'text', text: 'Editing the shutdown path.' },
      ]),
    );
    expect(h.render()).toEqual(['assistant:Editing the shutdown path.']);

    assistant.updateContent(
      assistantMessage([
        { type: 'thinking', thinking: 'First private step.' },
        { type: 'thinking', thinking: 'Second private step.' },
        { type: 'text', text: 'Editing the shutdown path.' },
        { type: 'toolCall', id: 'edit-1', name: 'edit', arguments: {} },
      ]),
    );
    h.chat.addChild(new FakeTool('edit', 'edit-1', {}));
    expect(h.render()).toEqual(['group:group-1:2:live']);
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

  it('reports when a live group takes over saying what is happening', () => {
    const { renderer } = recordingRenderer();
    const changes: boolean[] = [];
    const h = harness({ onLiveChange: (value) => changes.push(value) });
    uninstall = installToolSequenceShim(renderer, h.host);

    // Nothing on screen yet, so nothing to stand down for.
    h.render();
    expect(changes).toEqual([]);

    turn(h, [{ name: 'read' }], 'a');
    h.render();
    h.render();
    // Reported on the change, not on every frame.
    expect(changes).toEqual([true]);

    // The run ends: the group stops spinning and the host has its line back.
    h.setBusy(false);
    h.render();
    expect(changes).toEqual([true, false]);

    // And uninstalling while live hands it back too.
    h.setBusy(true);
    h.render();
    uninstall?.();
    uninstall = undefined;
    expect(changes).toEqual([true, false, true, false]);
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

  it('produces retry-aware aggregate outcomes in snapshots', () => {
    const { renderer, snapshots } = recordingRenderer();
    const h = harness();
    uninstall = installToolSequenceShim(renderer, h.host);

    const [lint, edit, retry] = turn(
      h,
      [
        { name: 'bash', args: { command: 'npm run lint' } },
        { name: 'edit', args: { path: 'src/index.ts' } },
        { name: 'bash', args: { command: 'npm run lint' } },
      ],
      'retry',
    );
    lint?.updateResult({ isError: true });
    edit?.updateResult({ isError: false });
    retry?.updateResult({ isError: false });
    h.setBusy(false);

    h.render();
    expect(snapshots.at(-1)).toMatchObject({ failed: false });
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

    // Giving up has to outlive a regrouping. Sequences are rebuilt whenever the
    // transcript changes, which during streaming is constantly, so a group that
    // forgot it had failed would throw again on every render and burn through
    // the fault budget on what is really one broken group.
    turn(h, [{ name: 'read' }], 'b');
    h.render();
    h.render();
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('gives up once the faults keep coming', () => {
    const onError = vi.fn();
    const onWarn = vi.fn();
    const h = harness({ onError, onWarn });
    uninstall = installToolSequenceShim(() => {
      throw new Error('boom');
    }, h.host);

    // Three groups, each breaking once: editing, then enough pure reading to
    // count as having moved on, then editing again. A group that has already
    // failed stays failed, so only distinct groups can drive the count up —
    // which is the point, since a single broken group is not a pattern.
    turn(h, [{ name: 'edit' }], 'e0');
    turn(
      h,
      Array.from({ length: 5 }, () => ({ name: 'read' })),
      'r0',
    );
    turn(h, [{ name: 'edit' }], 'e1');
    h.render();

    expect(onWarn).toHaveBeenCalledTimes(2);
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
