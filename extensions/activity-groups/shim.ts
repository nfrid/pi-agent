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
 * `grouping.ts` for where the boundaries fall. Its leader, the assistant
 * message that opened the phase, renders the summary; every other member
 * renders nothing. Nothing is removed from the container, so expanding a group
 * is just replaying the members' original `render`.
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
  type ActivityKind,
  type ActivityPhase,
  activityKind,
  phaseAfter,
  startsNewGroup,
} from './grouping';
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

  /**
   * One model turn: the assistant message that carried the tool calls, plus the
   * tool components that followed it. Turns are the unit that gets merged into
   * groups; `undefined` marks a break that no group may span.
   */
  type Turn = { members: Component[]; tools: ToolComponentLike[] } | undefined;

  function turnsOf(container: ContainerLike): Turn[] {
    const turns: Turn[] = [];
    let open: Exclude<Turn, undefined> | undefined;

    const close = () => {
      if (open) turns.push(open);
      open = undefined;
    };

    for (const child of container.children) {
      if (isAssistant(child)) {
        close();
        // A plain answer is a break; a message carrying tool calls opens a turn.
        if (child.hasToolCalls) open = { members: [child], tools: [] };
        else turns.push(undefined);
        continue;
      }
      if (isTool(child)) {
        if (child.ui && !capturedUi) capturedUi = child.ui;
        // Tools with no preceding assistant message still form a turn.
        open ??= { members: [], tools: [] };
        open.members.push(child);
        open.tools.push(child);
        continue;
      }
      close();
      turns.push(undefined);
    }
    close();
    return turns;
  }

  function recompute(): void {
    const nextBindings = new Map<Component, Sequence>();
    const seen = new Set<string>();

    for (const container of containers) {
      const last = container.children.at(-1);
      let open: Sequence | undefined;
      let openPhase: ActivityPhase | undefined;

      const flush = () => {
        if (open) {
          open.atTail = open.members.at(-1) === last;
          seen.add(open.id);
          for (const member of open.members) nextBindings.set(member, open);
        }
        open = undefined;
        openPhase = undefined;
      };

      for (const turn of turnsOf(container)) {
        if (!turn) {
          flush();
          continue;
        }
        // A turn whose tools have not arrived yet cannot set the phase, so it
        // continues the open group rather than guessing at a new one.
        const kind: ActivityKind =
          turn.tools.length > 0
            ? activityKind(
                turn.tools.map((tool) => ({
                  name: tool.toolName,
                  args: tool.args,
                })),
              )
            : 'inspect';

        if (
          startsNewGroup(
            open && openPhase
              ? { phase: openPhase, calls: open.tools.length }
              : undefined,
            kind,
          )
        ) {
          flush();
          const leader = turn.members[0];
          if (!leader) continue;
          open = {
            id: groupId(leader),
            members: [...turn.members],
            leader,
            tools: [...turn.tools],
            atTail: false,
          };
          openPhase = phaseAfter(undefined, kind);
          continue;
        }
        if (!open) continue;
        open.members.push(...turn.members);
        open.tools.push(...turn.tools);
        openPhase = phaseAfter(openPhase, kind);
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
