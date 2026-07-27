/**
 * The tool-sequence renderer contract.
 *
 * This mirrors the `registerToolSequenceRenderer` API proposed upstream
 * (pi-mono `feat(coding-agent): add extension transcript renderers`). The
 * renderer in `renderer.ts` is written against these types only, so it runs
 * unchanged whether the host provides the hook natively or `shim.ts` fakes it
 * by patching the interactive-mode components.
 */

import type {
  AssistantMessage,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';

export type SequenceItem =
  | { type: 'assistant'; message: AssistantMessage; provisional: boolean }
  | {
      type: 'tool';
      id: string;
      name: string;
      args: unknown;
      status: 'pending' | 'running' | 'complete';
      isError: boolean;
      result?: ToolResultMessage;
    };

export interface SequenceSnapshot {
  /** ID of the first tool call in the sequence; stable across live and historical rendering. */
  id: string;
  cwd: string;
  startedAt: number;
  /** Absent when the sequence was never observed live (history replay), so no duration is shown. */
  completedAt?: number;
  failed: boolean;
  items: readonly SequenceItem[];
}

export interface SequenceOptions {
  streaming: boolean;
  expanded: boolean;
  /** Exact built-in assistant and tool rendering, for expanded details or fallback. */
  defaultView: Component;
}

export interface RendererContext {
  /** Renderer-owned state retained for the lifetime of the sequence. */
  state: Map<string, unknown>;
  /** Component returned by the previous invocation for this sequence, if any. */
  lastComponent?: Component;
  /** Schedule an interactive-mode redraw. */
  requestRender(): void;
}

export type SequenceRenderer = (
  sequence: SequenceSnapshot,
  options: SequenceOptions,
  theme: Theme,
  context: RendererContext,
) => Component | undefined;
