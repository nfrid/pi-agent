import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';

/** Hidden session marker used only to kick an idle agent turn. */
export const CONTINUE_CUSTOM_TYPE = 'continue';

const INCOMPLETE_STOP_REASONS = new Set([
  'aborted',
  'error',
  'length',
  'toolUse',
]);

export type AgentMessage = ContextEvent['messages'][number];
type AssistantLike = Extract<AgentMessage, { role: 'assistant' }>;
type CustomLike = Extract<AgentMessage, { role: 'custom' }>;

function isAssistantMessage(message: AgentMessage): message is AssistantLike {
  return message.role === 'assistant';
}

function isCustomMessage(message: AgentMessage): message is CustomLike {
  return message.role === 'custom';
}

/** Assistant turns that should be dropped so the model can retry from earlier context. */
export function isIncompleteAssistant(message: AgentMessage): boolean {
  return (
    isAssistantMessage(message) &&
    INCOMPLETE_STOP_REASONS.has(message.stopReason)
  );
}

function isContinueMarker(message: AgentMessage): boolean {
  return (
    isCustomMessage(message) && message.customType === CONTINUE_CUSTOM_TYPE
  );
}

/**
 * Build LLM context for a silent continue: drop continue markers and any
 * interrupted assistant turns immediately before them (matching Pi's retry path).
 */
export function prepareContinueContext(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  const result: AgentMessage[] = [];

  for (const message of messages) {
    if (isContinueMarker(message)) {
      while (result.length > 0) {
        const previous = result[result.length - 1];
        if (!previous || !isIncompleteAssistant(previous)) break;
        result.pop();
      }
      continue;
    }
    result.push(message);
  }

  return result;
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === 'message') return entry.message;
  return undefined;
}

export function messagesFromBranch(
  branch: readonly SessionEntry[],
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const entry of branch) {
    const message = entryToMessage(entry);
    if (message) messages.push(message);
  }
  return messages;
}

/** Whether `/continue` can start a turn that ends on a user/tool-result (not a finished assistant). */
export function canContinue(messages: readonly AgentMessage[]): boolean {
  const prepared = prepareContinueContext([
    ...messages,
    {
      role: 'custom',
      customType: CONTINUE_CUSTOM_TYPE,
      content: [],
      display: false,
      timestamp: Date.now(),
    },
  ]);

  if (prepared.length === 0) return false;
  const last = prepared[prepared.length - 1];
  return last !== undefined && !isAssistantMessage(last);
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: 'info' | 'warning' | 'error' = 'warning',
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

export default function continueExtension(pi: ExtensionAPI): void {
  pi.registerCommand('continue', {
    description:
      'Continue after an interruption without sending a new user message',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        notify(ctx, 'Agent is already running.', 'warning');
        return;
      }

      const messages = messagesFromBranch(ctx.sessionManager.getBranch());
      if (!canContinue(messages)) {
        notify(
          ctx,
          'Nothing to continue — the last turn already finished.',
          'warning',
        );
        return;
      }

      pi.sendMessage(
        {
          customType: CONTINUE_CUSTOM_TYPE,
          content: [],
          display: false,
        },
        { triggerTurn: true },
      );
    },
  });

  pi.on('context', async (event) => {
    if (!event.messages.some(isContinueMarker)) return;
    return { messages: prepareContinueContext(event.messages) };
  });
}
