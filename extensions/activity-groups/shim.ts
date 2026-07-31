/**
 * Compatibility shim: drives the tool-sequence renderer on a Pi build that has
 * no `registerToolSequenceRenderer` hook.
 *
 * Pi ships as unbundled ESM and re-exports its interactive components from the
 * package root, which is the exact module instance the running CLI uses (the
 * extension loader aliases `@earendil-works/pi-coding-agent` to the installed
 * `dist/index.js`). So we can patch `render` on the component *prototypes*:
 * `new AssistantMessageComponent(...)` inside interactive-mode still produces
 * instances that route through us, while every `instanceof` check the host
 * performs on those instances keeps working — which swapping the classes would
 * have broken.
 *
 * A sequence spans as many model turns as belong to one phase of work — see
 * `grouping.ts` for where the boundaries fall. Its leader, the component that
 * opened the phase, renders the summary; every other member renders nothing.
 * Nothing is removed from the container, so expanding a group is just replaying
 * the members' original `render`.
 *
 * Anything the model says to the user ends the phase before it. What happens to
 * the line itself depends on what came next: work below it makes it that work's
 * preamble, so it leads the group and is printed once as its title; nothing
 * below it makes it an ordinary message, in no group, rendered by Pi untouched.
 * A message whose whole text is a narration header is not speech at all — see
 * `isNarration` — because some models write headers on the text channel.
 *
 * This reaches into host internals that carry no compatibility promise. Every
 * assumption is verified at install time and re-checked per sequence: anything
 * unexpected disables the shim (globally or for one sequence) and Pi's stock
 * rendering comes back.
 */

import type {
  AssistantMessage,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import {
  groupTranscript,
  type Narration,
  type TranscriptEntry,
} from './grouping';
import { hasUnresolvedToolFailure } from './outcome';
import { headersOf, isNarration } from './title';
import type {
  RendererContext,
  SequenceItem,
  SequenceRenderer,
  SequenceSnapshot,
} from './types';

type ComponentClass<T> = abstract new (...args: never[]) => T;

/** The subset of `AssistantMessageComponent` internals the shim reads. */
interface AssistantComponentLike extends Component {
  lastMessage?: AssistantMessage;
  updateContent(message: AssistantMessage): void;
}

/** The subset of `ToolExecutionComponent` internals the shim reads. */
interface ToolComponentLike extends Component {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: ToolResultMessage;
  isPartial: boolean;
  executionStarted: boolean;
  cwd: string;
  ui?: { requestRender(): void };
}

interface ContainerLike extends Component {
  children: Component[];
  addChild(component: Component): void;
  removeChild(component: Component): void;
  clear(): void;
}

export interface ShimHost {
  assistantComponent: ComponentClass<AssistantComponentLike>;
  toolComponent: ComponentClass<ToolComponentLike>;
  container: ComponentClass<ContainerLike>;
  /** Live theme, read per render so theme switches apply. */
  getTheme(): Theme;
  /** True while the agent is producing a turn. */
  isBusy(): boolean;
  /** Pi's global tool-output expansion state. */
  isExpanded(): boolean;
  /** Overrides the TUI handle captured from tool components. */
  requestRender?(): void;
  /**
   * Reports whether a group is currently live on screen, on every change. A
   * live group spins and names its own work, so the host can stand down
   * whatever else it shows to say the same thing.
   */
  onLiveChange?(live: boolean): void;
  /** Reports a fault that disabled grouping entirely. */
  onError?(error: unknown): void;
  /** Reports a fault that cost one group but left the rest running. */
  onWarn?(error: unknown): void;
  now?(): number;
}

interface Sequence {
  id: string;
  members: Component[];
  leader: Component;
  tools: ToolComponentLike[];
  /** True when the sequence is the tail of its container, so it may still grow. */
  atTail: boolean;
}

/**
 * What survives a regrouping. `Sequence` objects are rebuilt from scratch every
 * time the transcript changes, so anything that has to outlive that — timing,
 * the renderer's component, whether this group has given up — belongs here,
 * keyed by the group id.
 */
interface SequenceState {
  startedAt: number;
  completedAt?: number;
  /** False for sequences first seen already finished (history replay): no duration. */
  everLive: boolean;
  /** Set once this group has failed or opted out: it renders as Pi would. */
  disabled?: boolean;
  context: RendererContext;
}

/**
 * Render faults tolerated before the shim is judged unsafe. One group can fail
 * on its own; a fault that keeps recurring is not a one-off.
 */
const MAX_RENDER_FAILURES = 3;

function dispose(component: Component | undefined): void {
  (component as { dispose?: () => void } | undefined)?.dispose?.();
}

function toolStatus(
  tool: ToolComponentLike,
): 'pending' | 'running' | 'complete' {
  if (tool.result !== undefined && !tool.isPartial) return 'complete';
  if (tool.executionStarted || tool.result !== undefined) return 'running';
  return 'pending';
}

/**
 * Install the shim. Returns an uninstall function that restores every patched
 * prototype method and disposes renderer components.
 */
export function installToolSequenceShim(
  renderer: SequenceRenderer,
  host: ShimHost,
): () => void {
  const assistantProto = host.assistantComponent
    .prototype as AssistantComponentLike;
  const toolProto = host.toolComponent.prototype as ToolComponentLike;
  const containerProto = host.container.prototype as ContainerLike;

  const originalAssistantRender = assistantProto.render;
  const originalToolRender = toolProto.render;
  const originalUpdateContent = assistantProto.updateContent;
  const originalContainerRender = containerProto.render;
  const originalAddChild = containerProto.addChild;
  const originalRemoveChild = containerProto.removeChild;
  const originalClear = containerProto.clear;

  const now = () => host.now?.() ?? Date.now();
  const containers = new Set<ContainerLike>();
  const bindings = new Map<Component, Sequence>();
  /**
   * Assistants that just changed from hidden group content into speech.
   *
   * A preamble's text arrives before its tool-call block. In that brief gap the
   * grouper correctly treats the message as ordinary speech, but Pi's stock
   * renderer would also replay every thinking block that the live group had
   * hidden. Remember the transition so the preamble can stream on its own
   * without flashing those blocks before the tool component joins the group.
   */
  const hideTransitionThinking = new WeakSet<AssistantComponentLike>();
  const states = new Map<string, SequenceState>();
  let capturedUi: { requestRender(): void } | undefined;
  let dirty = true;
  let installed = true;
  let failures = 0;
  /** Whether the last completed pass over a chat container drew a live group. */
  let live = false;
  let sawLive = false;

  function setLive(next: boolean): void {
    if (next === live) return;
    live = next;
    host.onLiveChange?.(next);
  }

  /**
   * Group identity is tied to the component that leads it, not to a tool call
   * id: a group is opened by an assistant message whose tools have not arrived
   * yet, and its identity has to survive that gap so spinner and timing state
   * are not thrown away the moment the first tool appears.
   */
  const groupIds = new WeakMap<Component, string>();
  let nextGroupId = 0;
  const groupId = (leader: Component): string => {
    const existing = groupIds.get(leader);
    if (existing !== undefined) return existing;
    nextGroupId += 1;
    const id = `group-${nextGroupId}`;
    groupIds.set(leader, id);
    return id;
  };

  const isAssistant = (value: unknown): value is AssistantComponentLike =>
    value instanceof host.assistantComponent;
  const isTool = (value: unknown): value is ToolComponentLike =>
    value instanceof host.toolComponent;
  const isGroupable = (value: unknown): boolean =>
    isAssistant(value) || isTool(value);

  /**
   * Whether the message says something to the user, as opposed to only thinking
   * out loud. Pi renders text, thinking and tool calls from one component, so a
   * message that speaks cannot be summarised away without eating what it said.
   */
  const speaks = (component: AssistantComponentLike): boolean =>
    component.lastMessage?.content.some(
      (content) =>
        content.type === 'text' &&
        content.text.trim() !== '' &&
        !isNarration(content.text),
    ) ?? false;

  /**
   * How the message narrated itself, if it did. A header the model wrote where
   * the user can read it is worth more as a boundary than the same line in
   * thinking — see `Narration` — so the channel is carried, not just the fact.
   */
  const narrationOf = (message: AssistantMessage): Narration | undefined => {
    if (headersOf(message, 'text').length > 0) return 'announced';
    return headersOf(message, 'thinking').length > 0 ? 'thought' : undefined;
  };

  function requestRender(): void {
    if (host.requestRender) {
      host.requestRender();
      return;
    }
    capturedUi?.requestRender();
  }

  function teardown(error: unknown): void {
    if (!installed) return;
    installed = false;
    assistantProto.render = originalAssistantRender;
    toolProto.render = originalToolRender;
    assistantProto.updateContent = originalUpdateContent;
    containerProto.render = originalContainerRender;
    containerProto.addChild = originalAddChild;
    containerProto.removeChild = originalRemoveChild;
    containerProto.clear = originalClear;
    // Whatever the host stood down for a live group, it has back.
    setLive(false);
    for (const state of states.values()) dispose(state.context.lastComponent);
    states.clear();
    bindings.clear();
    containers.clear();
    if (error !== undefined) host.onError?.(error);
    requestRender();
  }

  /**
   * The transcript a container holds, in the shape the grouper reads. This is
   * the only place component internals are turned into plain data; every
   * boundary decision happens in `grouping.ts` against this.
   */
  function transcriptOf(container: ContainerLike): TranscriptEntry[] {
    return container.children.map((child) => {
      const closesGroup = runEnds.has(child) || undefined;
      if (isAssistant(child))
        return {
          kind: 'assistant' as const,
          speaks: speaks(child),
          // The model's own account of what it is starting, which is where a
          // group of work that nothing else distinguishes is cut.
          narration: child.lastMessage
            ? narrationOf(child.lastMessage)
            : undefined,
          closesGroup,
        };
      if (isTool(child))
        return {
          kind: 'tool' as const,
          name: child.toolName,
          args: child.args,
          closesGroup,
        };
      return { kind: 'other' as const, closesGroup };
    });
  }

  /**
   * Remember where a run stopped.
   *
   * A group that has rendered its checkmark must never start growing again —
   * the user watched it finish, and taking that back is jarring and makes the
   * mark a lie. Usually the next request puts a user message in the way, but
   * nothing guarantees that, so the moment a group is drawn as finished while
   * still at the tail is recorded as a boundary in its own right. It is the
   * one thing about grouping only a live session knows; a session read back
   * from disk has the user's messages to break on.
   */
  const runEnds = new WeakSet<Component>();

  function noteRunEnd(sequence: Sequence): void {
    const last = sequence.members.at(-1);
    if (!last || runEnds.has(last)) return;
    runEnds.add(last);
    dirty = true;
  }

  function recompute(): void {
    const nextBindings = new Map<Component, Sequence>();
    const seen = new Set<string>();

    for (const container of containers) {
      const children = container.children;
      for (const group of groupTranscript(transcriptOf(container))) {
        const members = children.slice(group.start, group.end + 1);
        const leader = members[0];
        if (!leader) continue;
        const sequence: Sequence = {
          id: groupId(leader),
          members,
          leader,
          tools: members.filter(isTool),
          atTail: group.end === children.length - 1,
        };
        // Tool components carry the TUI handle, and asking for a redraw is the
        // only way a spinner frame reaches the screen. Any of them will do.
        capturedUi ??= sequence.tools[0]?.ui;
        seen.add(sequence.id);
        for (const member of members) nextBindings.set(member, sequence);
      }
    }

    for (const [id, state] of states) {
      if (seen.has(id)) continue;
      dispose(state.context.lastComponent);
      states.delete(id);
    }

    bindings.clear();
    for (const [component, sequence] of nextBindings)
      bindings.set(component, sequence);
    dirty = false;
  }

  function ensureFresh(): void {
    if (dirty) recompute();
  }

  function originalRenderOf(component: Component, width: number): string[] {
    if (isTool(component)) return originalToolRender.call(component, width);
    return originalAssistantRender.call(component, width);
  }

  /** Render an assistant's visible speech without replaying hidden thinking. */
  function renderWithoutThinking(
    component: AssistantComponentLike,
    width: number,
  ): string[] {
    const message = component.lastMessage;
    if (!message) return originalAssistantRender.call(component, width);
    const visible = {
      ...message,
      content: message.content.filter((content) => content.type !== 'thinking'),
    };
    originalUpdateContent.call(component, visible);
    try {
      return originalAssistantRender.call(component, width);
    } finally {
      originalUpdateContent.call(component, message);
    }
  }

  function stateOf(sequence: Sequence): SequenceState {
    const existing = states.get(sequence.id);
    if (existing) return existing;
    const state: SequenceState = {
      startedAt: now(),
      everLive: false,
      context: { requestRender },
    };
    states.set(sequence.id, state);
    return state;
  }

  function snapshot(
    sequence: Sequence,
    state: SequenceState,
  ): SequenceSnapshot {
    const items: SequenceItem[] = [];
    for (const member of sequence.members) {
      if (isTool(member)) {
        items.push({
          type: 'tool',
          id: member.toolCallId,
          name: member.toolName,
          args: member.args,
          status: toolStatus(member),
          isError: member.result?.isError ?? false,
        });
        continue;
      }
      if (isAssistant(member) && member.lastMessage)
        items.push({ type: 'assistant', message: member.lastMessage });
    }
    return {
      id: sequence.id,
      cwd: sequence.tools[0]?.cwd ?? process.cwd(),
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      failed: hasUnresolvedToolFailure(items),
      items,
    };
  }

  function renderSequence(sequence: Sequence, width: number): string[] {
    const state = stateOf(sequence);
    const streaming = sequence.atTail && host.isBusy();
    if (streaming) {
      sawLive = true;
      state.everLive = true;
      state.completedAt = undefined;
    } else {
      // Shown as finished while it was still the tail: this is where the run
      // stopped, and the group closes for good.
      if (sequence.atTail) noteRunEnd(sequence);
      if (state.everLive && state.completedAt === undefined)
        state.completedAt = now();
    }

    const view = renderer(
      snapshot(sequence, state),
      {
        streaming,
        expanded: host.isExpanded(),
        defaultView: {
          render: (innerWidth: number) =>
            sequence.members.flatMap((member) =>
              originalRenderOf(member, innerWidth),
            ),
          invalidate: () => {
            for (const member of sequence.members) member.invalidate();
          },
        },
      },
      host.getTheme(),
      state.context,
    );

    if (!view) {
      // The renderer opted out for this sequence; show it verbatim.
      state.disabled = true;
      dispose(state.context.lastComponent);
      state.context.lastComponent = undefined;
      return originalRenderOf(sequence.leader, width);
    }
    if (state.context.lastComponent && state.context.lastComponent !== view)
      dispose(state.context.lastComponent);
    state.context.lastComponent = view;
    return view.render(width);
  }

  function renderMember(component: Component, width: number): string[] {
    if (!installed) return originalRenderOf(component, width);
    let sequence: Sequence | undefined;
    try {
      ensureFresh();
      sequence = bindings.get(component);
      if (!sequence || states.get(sequence.id)?.disabled) {
        if (
          isAssistant(component) &&
          hideTransitionThinking.has(component) &&
          host.isBusy()
        )
          return renderWithoutThinking(component, width);
        return originalRenderOf(component, width);
      }
      if (sequence.leader !== component) return [];
      return renderSequence(sequence, width);
    } catch (error) {
      // One broken group must take down neither the transcript nor the whole
      // feature: that group drops back to Pi's own rendering and the rest carry
      // on. Only a fault that keeps recurring, or one from deriving the groups
      // themselves, means the shim is no longer safe to run.
      failures += 1;
      if (sequence) stateOf(sequence).disabled = true;
      if (sequence && failures < MAX_RENDER_FAILURES) host.onWarn?.(error);
      else teardown(error);
      return originalRenderOf(component, width);
    }
  }

  assistantProto.render = function patchedAssistantRender(
    this: Component,
    width: number,
  ) {
    return renderMember(this, width);
  };
  toolProto.render = function patchedToolRender(
    this: Component,
    width: number,
  ) {
    return renderMember(this, width);
  };
  assistantProto.updateContent = function patchedUpdateContent(
    this: AssistantComponentLike,
    message: AssistantMessage,
  ) {
    // This replaces `lastMessage`, which is where the grouper reads whether the
    // message speaks and what it narrated — so boundaries can move.
    const wasGrouped = bindings.has(this);
    originalUpdateContent.call(this, message);
    if (wasGrouped && speaks(this)) hideTransitionThinking.add(this);
    dirty = true;
  };
  containerProto.render = function patchedContainerRender(
    this: ContainerLike,
    width: number,
  ) {
    // A resumed session is rebuilt from disk before this extension loads, so
    // its chat container is never seen through `addChild` and used to render
    // with no groups at all until the next turn arrived. Recognising a
    // container by what it holds is what makes history group exactly like live
    // work. Once found it is a set lookup; until then it is a scan that stops
    // at the first message, and containers that hold no messages are small.
    if (!containers.has(this) && this.children.some(isGroupable)) {
      containers.add(this);
      dirty = true;
    }
    if (!containers.has(this)) return originalContainerRender.call(this, width);
    // A pass over the transcript is the one moment the answer is knowable: a
    // group that is live says so by rendering, and one that has finished says
    // so by not. Nothing nests here — the containers this set holds are the
    // ones that hold messages, and messages hold no transcript of their own.
    sawLive = false;
    try {
      return originalContainerRender.call(this, width);
    } finally {
      setLive(sawLive);
    }
  };
  containerProto.addChild = function patchedAddChild(
    this: ContainerLike,
    component: Component,
  ) {
    originalAddChild.call(this, component);
    if (isAssistant(component) || isTool(component)) {
      containers.add(this);
      dirty = true;
    }
  };
  containerProto.removeChild = function patchedRemoveChild(
    this: ContainerLike,
    component: Component,
  ) {
    originalRemoveChild.call(this, component);
    if (containers.has(this)) dirty = true;
  };
  containerProto.clear = function patchedClear(this: ContainerLike) {
    originalClear.call(this);
    if (containers.has(this)) dirty = true;
  };

  return () => teardown(undefined);
}
