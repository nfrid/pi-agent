import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Static, TSchema } from 'typebox';
import { loadGuidelines } from '../shared/instructions';
import { formatPeek, formatSummary } from './format';
import type { BackgroundManager, BackgroundSnapshot } from './manager';
import { renderBackgroundCall, renderBackgroundResult } from './renderers';
import {
  type BackgroundAction,
  type BackgroundToolDetails,
  DEFAULT_TAIL_LINES,
  ListParameters,
  PeekParameters,
  type PeekParams,
  processDetails,
  StartParameters,
  type StartParams,
  StopParameters,
  type StopParams,
  UnwatchParameters,
  type UnwatchParams,
  type WatchInput,
  WatchParameters,
  type WatchParams,
} from './schema';

const START_DESCRIPTION =
  'Launch a non-interactive Bash command with /bin/bash -c and no stdin that outlives the current turn. The process survives parent Pi session shutdown; completion is delivered automatically, and stop is explicit.';
const PEEK_DESCRIPTION =
  'Inspect one retained background process immediately. This never waits; use completion notifications instead of polling.';
const LIST_DESCRIPTION =
  'List retained background processes and their one-shot output watch status.';
const STOP_DESCRIPTION =
  'Terminate one or more background processes and suppress redundant completion notifications.';
const WATCH_DESCRIPTION =
  'Add one-shot literal future-output watches to a running background process. A watch reports match, timeout, or process end and never kills the process.';
const UNWATCH_DESCRIPTION =
  'Remove one or more output watches without stopping the background process.';

const START_GUIDELINES = loadGuidelines('instructions.md', __dirname);

type ToolState = { processes?: Map<string, ProcessDetails> };
type ProcessDetails = ReturnType<typeof processDetails>;
type ToolResult = {
  content: [{ type: 'text'; text: string }];
  details: BackgroundToolDetails;
};
type OperationContext = Pick<ExtensionContext, 'cwd'>;
type Operation<T extends TSchema> = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  action: BackgroundAction;
  parameters: T;
  promptGuidelines?: string[];
  execute: (
    params: Static<T>,
    signal: AbortSignal | undefined,
    ctx: OperationContext,
  ) => Promise<ToolResult>;
};

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function validateCwd(base: string, requested?: string): string {
  const cwd = resolve(base, requested ?? '.');
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }
  return cwd;
}

function hostWatches(watches: readonly WatchInput[]) {
  return watches.map(({ contains, stream, timeout_seconds }) => ({
    contains,
    ...(stream ? { stream } : {}),
    ...(timeout_seconds === undefined
      ? {}
      : { timeoutMs: timeout_seconds * 1000 }),
  }));
}

function registerOperation<T extends TSchema>(
  pi: ExtensionAPI,
  operation: Operation<T>,
  resolveProcess: (id: string) => BackgroundSnapshot | undefined,
): void {
  pi.registerTool<T, BackgroundToolDetails, ToolState>({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    promptSnippet: operation.promptSnippet,
    ...(operation.promptGuidelines
      ? { promptGuidelines: operation.promptGuidelines }
      : {}),
    parameters: operation.parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return operation.execute(params, signal, ctx);
    },
    renderCall: (args, theme, context) =>
      renderBackgroundCall(
        { ...(args as Record<string, unknown>), action: operation.action },
        theme,
        context,
        (id) => context?.state?.processes?.get(id) ?? resolveProcess(id),
      ),
    renderResult: (result, options, theme, context) => {
      // Historical tool rows can outlive the manager's retained process cache.
      // Share their result titles with the call renderer, without host I/O.
      if (context?.state && result.details) {
        const processes = result.details.process
          ? [result.details.process]
          : (result.details.processes ?? []);
        context.state.processes ??= new Map();
        const cached = context.state.processes;
        let changed = false;
        for (const process of processes) {
          if (cached.get(process.id)?.title !== process.title) changed = true;
          cached.set(process.id, process);
        }
        if (changed) context.invalidate();
      }
      return renderBackgroundResult(result, options, theme);
    },
  });
}

function start(
  params: StartParams,
  _signal: AbortSignal | undefined,
  ctx: OperationContext,
  getManager: () => BackgroundManager,
): Promise<ToolResult> {
  const command = requireText(params.command, 'command');
  const title =
    params.title === undefined
      ? undefined
      : requireText(params.title, 'title').replace(/\s+/gu, ' ');
  const cwd = validateCwd(ctx.cwd, params.cwd);
  return getManager()
    .start({
      command,
      title,
      cwd,
      ...(params.watch ? { watch: hostWatches(params.watch) } : {}),
    })
    .then((snapshot) => ({
      content: [
        {
          type: 'text' as const,
          text: `Started ${formatSummary(snapshot)}.\nCompletion and watch outcomes will be delivered automatically; do not poll.`,
        },
      ],
      details: { action: 'start' as const, process: processDetails(snapshot) },
    }));
}

async function peek(
  params: PeekParams,
  signal: AbortSignal | undefined,
  getManager: () => BackgroundManager,
  cancelCompletion: (id: string) => boolean,
): Promise<ToolResult> {
  const id = requireText(params.id, 'id');
  const snapshot = await getManager().peek(id, signal);
  if (snapshot.status !== 'running') cancelCompletion(id);
  return {
    content: [
      {
        type: 'text',
        text: formatPeek(snapshot, params.tail_lines ?? DEFAULT_TAIL_LINES),
      },
    ],
    details: { action: 'peek', process: processDetails(snapshot) },
  };
}

async function list(getManager: () => BackgroundManager): Promise<ToolResult> {
  const snapshots = await getManager().list();
  return {
    content: [
      {
        type: 'text',
        text:
          snapshots.length === 0
            ? 'No background processes.'
            : snapshots.map((snapshot) => formatSummary(snapshot)).join('\n'),
      },
    ],
    details: {
      action: 'list',
      processes: snapshots.map(processDetails),
    },
  };
}

async function stop(
  params: StopParams,
  signal: AbortSignal | undefined,
  getManager: () => BackgroundManager,
  cancelCompletion: (id: string) => boolean,
): Promise<ToolResult> {
  const ids = params.ids.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('ids is required.');
  const snapshots = await getManager().stop(ids, signal);
  for (const snapshot of snapshots) cancelCompletion(snapshot.id);
  return {
    content: [
      {
        type: 'text',
        text: snapshots.map((snapshot) => formatSummary(snapshot)).join('\n'),
      },
    ],
    details: {
      action: 'stop',
      processes: snapshots.map(processDetails),
    },
  };
}

async function watch(
  params: WatchParams,
  getManager: () => BackgroundManager,
): Promise<ToolResult> {
  const id = requireText(params.id, 'id');
  const snapshot = await getManager().watch(id, hostWatches(params.watch));
  return {
    content: [
      { type: 'text', text: `Added watches. ${formatSummary(snapshot)}` },
    ],
    details: { action: 'watch', process: processDetails(snapshot) },
  };
}

async function unwatch(
  params: UnwatchParams,
  getManager: () => BackgroundManager,
): Promise<ToolResult> {
  const id = requireText(params.id, 'id');
  const watchIds = params.watch_ids
    .map((watchId) => watchId.trim())
    .filter(Boolean);
  if (watchIds.length === 0) throw new Error('watch_ids is required.');
  const snapshot = await getManager().unwatch(id, watchIds);
  return {
    content: [
      { type: 'text', text: `Removed watches. ${formatSummary(snapshot)}` },
    ],
    details: { action: 'unwatch', process: processDetails(snapshot) },
  };
}

export function registerBackgroundTools(
  pi: ExtensionAPI,
  getManager: () => BackgroundManager,
  cancelCompletion: (id: string) => boolean = () => false,
  resolveProcess: (id: string) => BackgroundSnapshot | undefined = () =>
    undefined,
): void {
  registerOperation(
    pi,
    {
      name: 'background_start',
      label: 'Background Start',
      description: START_DESCRIPTION,
      promptSnippet: 'Start a long-running non-interactive Bash command',
      promptGuidelines: START_GUIDELINES,
      action: 'start',
      parameters: StartParameters,
      execute: (params, signal, ctx) => start(params, signal, ctx, getManager),
    },
    resolveProcess,
  );
  registerOperation(
    pi,
    {
      name: 'background_peek',
      label: 'Background Peek',
      description: PEEK_DESCRIPTION,
      promptSnippet: 'Inspect a background process without waiting',
      action: 'peek',
      parameters: PeekParameters,
      execute: (params, signal) =>
        peek(params, signal, getManager, cancelCompletion),
    },
    resolveProcess,
  );
  registerOperation(
    pi,
    {
      name: 'background_list',
      label: 'Background List',
      description: LIST_DESCRIPTION,
      promptSnippet: 'List retained background processes and watches',
      action: 'list',
      parameters: ListParameters,
      execute: () => list(getManager),
    },
    resolveProcess,
  );
  registerOperation(
    pi,
    {
      name: 'background_stop',
      label: 'Background Stop',
      description: STOP_DESCRIPTION,
      promptSnippet: 'Stop one or more background processes',
      action: 'stop',
      parameters: StopParameters,
      execute: (params, signal) =>
        stop(params, signal, getManager, cancelCompletion),
    },
    resolveProcess,
  );
  registerOperation(
    pi,
    {
      name: 'background_watch',
      label: 'Background Watch',
      description: WATCH_DESCRIPTION,
      promptSnippet: 'Watch future output from a background process',
      action: 'watch',
      parameters: WatchParameters,
      execute: (params) => watch(params, getManager),
    },
    resolveProcess,
  );
  registerOperation(
    pi,
    {
      name: 'background_unwatch',
      label: 'Background Unwatch',
      description: UNWATCH_DESCRIPTION,
      promptSnippet: 'Remove watches without stopping a process',
      action: 'unwatch',
      parameters: UnwatchParameters,
      execute: (params) => unwatch(params, getManager),
    },
    resolveProcess,
  );
}
