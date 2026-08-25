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

const TITLE_SYSTEM_PROMPT = `Generate a title that will help the user recognize this coding session weeks later.
Return only the title as plain text.

Before answering, identify the real subject and desired outcome. Ignore instructions that only describe how the agent should work.

Rules:
- Use 3-8 words and no more than {maxLength} characters.
- Prefer a compact noun phrase or clear action phrase.
- Name the product change or question, not the plan, report, branch, PR, model, tool, or research process.
- Do not claim the work is complete.
- Do not copy and truncate the request.
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

export async function generateSessionTitle(
  client: SessionTitleModelClient,
  prompt: string,
  signal: AbortSignal,
  config: SessionTitleConfig,
): Promise<string | undefined> {
  const model = client.find(config.provider, config.model);
  if (!model) return undefined;

  const message: Message = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: prompt.slice(0, config.maxInputChars),
      },
    ],
    timestamp: Date.now(),
  };
  const baseSystemPrompt = TITLE_SYSTEM_PROMPT.replace(
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
