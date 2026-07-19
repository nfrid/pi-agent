import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export const THINKING_LABEL = 'Thinking...';
const DELEGATE_TOOL = 'delegate';
const ASK_USER_TOOL = 'ask_user_question';

type ModelPhase = 'thinking' | 'responding' | 'preparing-tools';

type ActiveTool = {
  name: string;
  subagents?: { completed: number; total: number };
};

type ToolBatch = {
  active: Map<string, ActiveTool>;
  completed: number;
  finishedSubagents: number;
  phase: ModelPhase;
  preparingToolName?: string;
  heldAction?: string;
  thinkingSectionsAfterTool: number;
};

export function createToolBatch(): ToolBatch {
  return {
    active: new Map(),
    completed: 0,
    finishedSubagents: 0,
    phase: 'thinking',
    thinkingSectionsAfterTool: 0,
  };
}

function modelPhaseLabel(batch: ToolBatch): string {
  if (batch.heldAction) return `${batch.heldAction}...`;
  switch (batch.phase) {
    case 'thinking':
      return THINKING_LABEL;
    case 'responding':
      return 'Responding...';
    case 'preparing-tools': {
      const action = batch.preparingToolName
        ? toolAction(batch.preparingToolName)
        : undefined;
      return action ? `${action}...` : 'Preparing tools...';
    }
  }
}

const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  artifact_retrieve: 'Retrieving artifact',
  bash: 'Running command',
  edit: 'Editing',
  fetch_content: 'Fetching pages',
  find: 'Finding files',
  get_search_content: 'Retrieving search results',
  grep: 'Searching files',
  ls: 'Listing files',
  read: 'Reading',
  todo: 'Updating tasks',
  web_search: 'Searching the web',
  write: 'Writing',
};

function toolAction(name: string): string | undefined {
  return TOOL_ACTIONS[name.split('.').at(-1) ?? name];
}

export function activityLabel(batch: ToolBatch): string {
  if (batch.active.size === 0) return modelPhaseLabel(batch);

  const active = [...batch.active.values()];
  if (active.some((tool) => tool.name === ASK_USER_TOOL)) {
    return 'Waiting for you...';
  }

  const delegates = active.filter((tool) => tool.name === DELEGATE_TOOL);
  if (delegates.length > 0) {
    const total =
      batch.finishedSubagents +
      delegates.reduce((sum, tool) => sum + (tool.subagents?.total ?? 1), 0);
    const completed =
      batch.finishedSubagents +
      delegates.reduce(
        (sum, tool) => sum + (tool.subagents?.completed ?? 0),
        0,
      );
    if (total === 1) return 'Waiting for subagent...';
    return `Waiting for subagents (${completed}/${total})...`;
  }

  const total = batch.completed + batch.active.size;
  if (batch.active.size === 1) {
    const action = toolAction(active[0].name);
    if (action)
      return total === 1
        ? `${action}...`
        : `${action} (${batch.completed}/${total})...`;
  }
  if (total === 1) return 'Waiting for tool...';
  return `Waiting for tools (${batch.completed}/${total})...`;
}

function streamedToolName(event: {
  contentIndex?: number;
  partial?: { content?: unknown[] };
  toolCall?: { name?: unknown };
}): string | undefined {
  if (typeof event.toolCall?.name === 'string') return event.toolCall.name;
  if (typeof event.contentIndex !== 'number' || !event.partial?.content) return;
  const content = event.partial.content[event.contentIndex];
  if (!content || typeof content !== 'object') return;
  const name = (content as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function subagentTotal(args: unknown): number {
  if (!args || typeof args !== 'object') return 1;
  const tasks = (args as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) && tasks.length > 0 ? tasks.length : 1;
}

function delegateProgress(
  partialResult: unknown,
): { completed: number; total: number } | undefined {
  if (!partialResult || typeof partialResult !== 'object') return;
  const details = (partialResult as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return;
  const runs = (details as { runs?: unknown }).runs;
  if (!Array.isArray(runs) || runs.length === 0) return;

  const completed = runs.filter((run) => {
    if (!run || typeof run !== 'object') return false;
    const state = (run as { state?: unknown }).state;
    if (
      state === 'success' ||
      state === 'error' ||
      state === 'aborted' ||
      state === 'timed-out'
    )
      return true;
    const exitCode = (run as { exitCode?: unknown }).exitCode;
    return typeof exitCode === 'number' && exitCode !== -1;
  }).length;
  return { completed, total: runs.length };
}

const registered = new WeakSet<object>();

export default function activityIndicator(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);

  let batch = createToolBatch();

  const show = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setWorkingMessage(activityLabel(batch));
  };

  const reset = (ctx: ExtensionContext) => {
    batch = createToolBatch();
    show(ctx);
  };

  const beginTurn = (ctx: ExtensionContext) => {
    const heldAction = batch.heldAction;
    const thinkingSectionsAfterTool = batch.thinkingSectionsAfterTool;
    batch = createToolBatch();
    batch.heldAction = heldAction;
    batch.thinkingSectionsAfterTool = thinkingSectionsAfterTool;
    show(ctx);
  };

  pi.on('session_start', (_event, ctx) => reset(ctx));
  pi.on('agent_start', (_event, ctx) => reset(ctx));
  pi.on('turn_start', (_event, ctx) => beginTurn(ctx));

  pi.on('message_update', (event, ctx) => {
    switch (event.assistantMessageEvent.type) {
      case 'thinking_start':
        batch.phase = 'thinking';
        if (batch.heldAction) {
          batch.thinkingSectionsAfterTool++;
          if (batch.thinkingSectionsAfterTool === 1) return;
          batch.heldAction = undefined;
        }
        break;
      case 'text_start':
        batch.heldAction = undefined;
        batch.phase = 'responding';
        break;
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end': {
        const name = streamedToolName(event.assistantMessageEvent);
        const startsTool =
          event.assistantMessageEvent.type === 'toolcall_start';
        if (
          batch.phase === 'preparing-tools' &&
          (batch.preparingToolName === name || (!name && !startsTool))
        )
          return;
        batch.heldAction = undefined;
        batch.phase = 'preparing-tools';
        batch.preparingToolName = name;
        break;
      }
      default:
        return;
    }
    show(ctx);
  });

  pi.on('tool_execution_start', (event, ctx) => {
    batch.heldAction = undefined;
    batch.active.set(event.toolCallId, {
      name: event.toolName,
      ...(event.toolName === DELEGATE_TOOL
        ? {
            subagents: {
              completed: 0,
              total: subagentTotal(event.args),
            },
          }
        : {}),
    });
    show(ctx);
  });

  pi.on('tool_execution_update', (event, ctx) => {
    const tool = batch.active.get(event.toolCallId);
    if (!tool || tool.name !== DELEGATE_TOOL) return;
    const progress = delegateProgress(event.partialResult);
    if (!progress) return;
    tool.subagents = progress;
    show(ctx);
  });

  pi.on('tool_execution_end', (event, ctx) => {
    const tool = batch.active.get(event.toolCallId);
    if (tool?.name === DELEGATE_TOOL) {
      batch.finishedSubagents += tool.subagents?.total ?? 1;
    }
    if (batch.active.delete(event.toolCallId)) batch.completed++;
    if (batch.active.size === 0) {
      batch.phase = 'thinking';
      batch.heldAction = tool ? toolAction(tool.name) : undefined;
      batch.thinkingSectionsAfterTool = 0;
    }
    show(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    batch = createToolBatch();
  });
}
