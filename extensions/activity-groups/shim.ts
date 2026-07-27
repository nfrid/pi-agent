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
 * Grouping mirrors the upstream semantics: one sequence per model turn, led by
 * the assistant message carrying the tool calls, followed by its tool
 * executions. The sequence leader renders the summary; the other members render
 * nothing. Nothing is removed from the container, so expanding a group is just
 * replaying the members' original `render`.
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
  hasToolCalls: boolean;
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
  /** Reports a fault that disabled grouping. */
  onError?(error: unknown): void;
  now?(): number;
}

interface Sequence {
  id: string;
  members: Component[];
  leader: Component;
  tools: ToolComponentLike[];
  /** True when the sequence is the tail of its container, so it may still grow. */
  atTail: boolean;
  disabled?: boolean;
}

interface SequenceState {
  startedAt: number;
  completedAt?: number;
  /** False for sequences first seen already finished (history replay): no duration. */
  everLive: boolean;
  context: RendererContext;
}

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
  const originalAddChild = containerProto.addChild;
  const originalRemoveChild = containerProto.removeChild;
  const originalClear = containerProto.clear;

  const now = () => host.now?.() ?? Date.now();
  const containers = new Set<ContainerLike>();
  const bindings = new Map<Component, Sequence>();
  const states = new Map<string, SequenceState>();
  let capturedUi: { requestRender(): void } | undefined;
  let dirty = true;
  let installed = true;

  const isAssistant = (value: unknown): value is AssistantComponentLike =>
    value instanceof host.assistantComponent;
  const isTool = (value: unknown): value is ToolComponentLike =>
    value instanceof host.toolComponent;

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
    containerProto.addChild = originalAddChild;
    containerProto.removeChild = originalRemoveChild;
    containerProto.clear = originalClear;
    for (const state of states.values()) dispose(state.context.lastComponent);
    states.clear();
    bindings.clear();
    containers.clear();
    if (error !== undefined) host.onError?.(error);
    requestRender();
  }

  function recompute(): void {
    const nextBindings = new Map<Component, Sequence>();
    const seen = new Set<string>();

    for (const container of containers) {
      const children = container.children;
      const last = children.at(-1);
      let members: Component[] = [];
      let tools: ToolComponentLike[] = [];

      const flush = () => {
        const first = tools[0];
        if (first && members.length > 0) {
          const leader = members[0] as Component;
          const sequence: Sequence = {
            id: first.toolCallId,
            members,
            leader,
            tools,
            atTail: members.at(-1) === last,
          };
          seen.add(sequence.id);
          for (const member of members) nextBindings.set(member, sequence);
        }
        members = [];
        tools = [];
      };

      for (const child of children) {
        if (isAssistant(child)) {
          // Each assistant message that carries tool calls opens a sequence;
          // a plain answer closes the preceding one and renders normally.
          flush();
          if (child.hasToolCalls) members.push(child);
          continue;
        }
        if (isTool(child)) {
          if (child.ui && !capturedUi) capturedUi = child.ui;
          members.push(child);
          tools.push(child);
          continue;
        }
        flush();
      }
      flush();
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

  function stateOf(sequence: Sequence): SequenceState {
    const existing = states.get(sequence.id);
    if (existing) return existing;
    const state: SequenceState = {
      startedAt: now(),
      everLive: false,
      context: {
        state: new Map<string, unknown>(),
        requestRender,
      },
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
          result: member.result,
        });
        continue;
      }
      if (isAssistant(member) && member.lastMessage) {
        items.push({
          type: 'assistant',
          message: member.lastMessage,
          provisional: !member.hasToolCalls,
        });
      }
    }
    return {
      id: sequence.id,
      cwd: sequence.tools[0]?.cwd ?? process.cwd(),
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      failed: items.some((item) => item.type === 'tool' && item.isError),
      items,
    };
  }

  function renderSequence(sequence: Sequence, width: number): string[] {
    const state = stateOf(sequence);
    const streaming = sequence.atTail && host.isBusy();
    if (streaming) {
      state.everLive = true;
      state.completedAt = undefined;
    } else if (state.everLive && state.completedAt === undefined) {
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
      sequence.disabled = true;
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
    try {
      ensureFresh();
      const sequence = bindings.get(component);
      if (!sequence || sequence.disabled)
        return originalRenderOf(component, width);
      if (sequence.leader !== component) return [];
      return renderSequence(sequence, width);
    } catch (error) {
      // A broken group must never take the transcript down with it.
      teardown(error);
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
    // `hasToolCalls` can flip here, which changes sequence membership.
    originalUpdateContent.call(this, message);
    dirty = true;
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
