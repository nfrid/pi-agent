import {
  type Api,
  type AssistantMessage,
  type Context,
  clampThinkingLevel,
  type Message,
  type Model,
  type ModelsApiStreamOptions,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import type { SessionTitleConfig } from './config.js';

const INITIAL_TITLE_SYSTEM_PROMPT = `Generate a title that will help the user recognize this coding session weeks later.
Return only the title as plain text.

Before answering, identify the real subject and desired outcome. Ignore instructions that only describe how the agent should work.

Rules:
- Use 3-8 words and no more than {maxLength} characters.
- Prefer a compact noun phrase or clear action phrase.
- Name the product change or question, not the plan, report, branch, PR, model, tool, or research process.
- Do not claim the work is complete.
- Do not copy and truncate the request.
- Avoid quotes, labels, filler, and trailing punctuation.`;

const HISTORY_TITLE_SYSTEM_PROMPT = `Generate an updated title for a coding session from its conversation so far.
Return only the title as plain text.

Identify the durable subject and current desired outcome across the conversation. Prefer the main task over incidental debugging steps or the latest minor detail.

Rules:
- Use 3-8 words and no more than {maxLength} characters.
- Prefer a compact noun phrase or clear action phrase.
- Name the product change or question, not the plan, report, branch, PR, model, tool, or research process.
- Do not claim the work is complete.
- Do not copy and truncate a message.
- Avoid quotes, labels, filler, and trailing punctuation.`;

export interface SessionTitleModelClient {
  find(provider: string, model: string): Model<Api> | undefined;
  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage>;
}

export function sanitizeSessionTitle(
  raw: string,
  maxLength = 50,
): string | undefined {
  const normalized = raw
    .trim()
    .split(/\r?\n/u)[0]
    ?.trim()
    .replace(/^[\s'"`]+|[\s'"`]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[.!?]+$/gu, '')
    .trim();

  if (!normalized) return undefined;
  if ([...normalized].length <= maxLength) return normalized;
  return `${[...normalized]
    .slice(0, maxLength - 3)
    .join('')
    .trimEnd()}...`;
}

function visibleMessage(
  entry: unknown,
): { role: 'user' | 'assistant'; text: string } | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const record = entry as Record<string, unknown>;
  const rawMessage = record.type === 'message' ? record.message : record;
  if (!rawMessage || typeof rawMessage !== 'object') return undefined;
  const message = rawMessage as Record<string, unknown>;
  if (message.role !== 'user' && message.role !== 'assistant') return undefined;
  const content = message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((part) =>
              part &&
              typeof part === 'object' &&
              (part as Record<string, unknown>).type === 'text' &&
              typeof (part as Record<string, unknown>).text === 'string'
                ? [(part as Record<string, unknown>).text as string]
                : [],
            )
            .join('\n')
        : '';
  const normalized = text.replace(/\r\n?/gu, '\n').trim();
  return normalized
    ? { role: message.role as 'user' | 'assistant', text: normalized }
    : undefined;
}

/**
 * Build a coherent low-detail transcript without slicing prose. Tool calls,
 * tool results, thinking, attachments, and metadata are omitted. When the
 * budget is exceeded, complete middle messages are dropped while the initial
 * request and newest complete messages are retained.
 */
export function liteSessionTitleMessages(
  entries: readonly unknown[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return entries.flatMap((entry) => {
    const message = visibleMessage(entry);
    return message ? [{ role: message.role, content: message.text }] : [];
  });
}

export function buildSessionTitleHistory(
  entries: readonly unknown[],
  maxChars: number,
): string | undefined {
  const messages = liteSessionTitleMessages(entries).map((message) => ({
    role: message.role,
    block: `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.content}`,
  }));
  const firstUserIndex = messages.findIndex(
    (message) => message.role === 'user',
  );
  if (firstUserIndex < 0) return undefined;
  const relevant = messages.slice(firstUserIndex);
  const complete = relevant.map((message) => message.block).join('\n\n');
  if (complete.length <= maxChars) return complete;

  const initial = relevant[0]?.block;
  if (!initial || initial.length > maxChars) return undefined;
  const turns: string[] = [];
  let turn: string[] = [];
  for (const message of relevant.slice(1)) {
    if (message.role === 'user') {
      if (turn.length > 0) turns.push(turn.join('\n\n'));
      turn = [message.block];
    } else if (turn.length > 0) {
      turn.push(message.block);
    }
  }
  if (turn.length > 0) turns.push(turn.join('\n\n'));

  const omitted = '[Earlier transcript turns omitted]';
  if (initial.length + 2 + omitted.length > maxChars) return initial;
  const recent: string[] = [];
  let used = initial.length + 2 + omitted.length;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const candidate = turns[index];
    if (!candidate || used + 2 + candidate.length > maxChars) continue;
    recent.unshift(candidate);
    used += 2 + candidate.length;
  }
  return [initial, omitted, ...recent].join('\n\n');
}

function reasoningOptions(
  model: Model<Api>,
  thinking: ModelThinkingLevel,
): Record<string, unknown> {
  switch (model.api) {
    case 'openai-codex-responses':
      return { reasoningEffort: thinking === 'off' ? 'none' : thinking };
    case 'openai-completions':
    case 'openai-responses':
    case 'azure-openai-responses':
      return thinking === 'off' ? {} : { reasoningEffort: thinking };
    case 'anthropic-messages':
      return thinking === 'off'
        ? { thinkingEnabled: false }
        : {
            thinkingEnabled: true,
            effort: thinking === 'minimal' ? 'low' : thinking,
            thinkingDisplay: 'omitted',
          };
    case 'google-generative-ai':
    case 'google-vertex':
      return thinking === 'off'
        ? { thinking: { enabled: false } }
        : {
            thinking: {
              enabled: true,
              level: (thinking === 'xhigh' || thinking === 'max'
                ? 'high'
                : thinking
              ).toUpperCase(),
            },
          };
    case 'mistral-conversations':
      return { reasoningEffort: thinking === 'off' ? 'none' : 'high' };
    case 'bedrock-converse-stream':
    case 'pi-messages':
      return thinking === 'off' ? {} : { reasoning: thinking };
    default:
      return {};
  }
}

async function completeSessionTitle(
  client: SessionTitleModelClient,
  input: string,
  systemTemplate: string,
  signal: AbortSignal,
  config: SessionTitleConfig,
): Promise<string | undefined> {
  const model = client.find(config.provider, config.model);
  if (!model) return undefined;

  const message: Message = {
    role: 'user',
    content: [{ type: 'text', text: input }],
    timestamp: Date.now(),
  };
  const baseSystemPrompt = systemTemplate.replace(
    '{maxLength}',
    String(config.maxLength),
  );
  const systemPrompt = config.instructions
    ? `${baseSystemPrompt}\n\nAdditional instructions:\n${config.instructions}`
    : baseSystemPrompt;
  const thinking = clampThinkingLevel(model, config.thinking);
  const response = await client.complete(
    model,
    { systemPrompt, messages: [message] },
    {
      signal,
      cacheRetention: 'none',
      maxTokens: config.maxOutputTokens,
      ...reasoningOptions(model, thinking),
    },
  );
  const title = response.content
    .filter(
      (part): part is { type: 'text'; text: string } => part.type === 'text',
    )
    .map((part) => part.text)
    .join(' ');
  return sanitizeSessionTitle(title, config.maxLength);
}

export function generateSessionTitle(
  client: SessionTitleModelClient,
  prompt: string,
  signal: AbortSignal,
  config: SessionTitleConfig,
): Promise<string | undefined> {
  return completeSessionTitle(
    client,
    prompt.slice(0, config.maxInputChars),
    INITIAL_TITLE_SYSTEM_PROMPT,
    signal,
    config,
  );
}

export function generateSessionTitleFromHistory(
  client: SessionTitleModelClient,
  entries: readonly unknown[],
  signal: AbortSignal,
  config: SessionTitleConfig,
): Promise<string | undefined> {
  const history = buildSessionTitleHistory(entries, config.maxInputChars);
  if (!history) return Promise.resolve(undefined);
  return completeSessionTitle(
    client,
    history,
    HISTORY_TITLE_SYSTEM_PROMPT,
    signal,
    config,
  );
}
