import {
  type Api,
  clampThinkingLevel,
  type Message,
  type Model,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';
import { loadSessionTitleConfig, type SessionTitleConfig } from './config';

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

function hasUserMessage(entries: readonly unknown[]): boolean {
  return entries.some((value) => {
    if (!value || typeof value !== 'object') return false;
    const entry = value as { type?: unknown; message?: unknown };
    if (entry.type !== 'message' || !entry.message) return false;
    return (entry.message as { role?: unknown }).role === 'user';
  });
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
  ctx: ExtensionContext,
  prompt: string,
  signal: AbortSignal,
  config: SessionTitleConfig,
): Promise<string | undefined> {
  const model = ctx.modelRegistry.find(config.provider, config.model);
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
  const response = await ctx.modelRegistry.complete(
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

type TitleGenerator = typeof generateSessionTitle;
type ConfigLoader = typeof loadSessionTitleConfig;

export function registerAutomaticSessionTitles(
  pi: ExtensionAPI,
  generate: TitleGenerator = generateSessionTitle,
  loadConfig: ConfigLoader = loadSessionTitleConfig,
): void {
  let config: SessionTitleConfig | undefined;
  let eligible = false;
  let started = false;
  let sessionController: AbortController | undefined;

  pi.on('session_start', (_event, ctx) => {
    sessionController?.abort();
    sessionController = new AbortController();
    config = loadConfig();
    started = false;
    eligible =
      config.enabled &&
      config.error === undefined &&
      pi.getSessionName() === undefined &&
      !hasUserMessage(ctx.sessionManager.getEntries());
    if (config.error) console.warn(config.error);
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (!eligible || started || pi.getSessionName() !== undefined) return;
    const prompt = event.prompt.trim();
    if (!prompt || !config) return;

    started = true;
    const sessionSignal = sessionController?.signal;
    if (!sessionSignal) return;
    const signal = AbortSignal.any([
      sessionSignal,
      AbortSignal.timeout(config.timeoutMs),
    ]);

    void generate(ctx, prompt, signal, config)
      .then((title) => {
        if (title && !signal.aborted && pi.getSessionName() === undefined) {
          pi.setSessionName(title);
        }
      })
      .catch((error: unknown) => {
        if (!signal.aborted) {
          console.warn('Automatic session title generation failed:', error);
        }
      });
  });

  pi.on('session_shutdown', () => {
    sessionController?.abort();
    sessionController = undefined;
    config = undefined;
    eligible = false;
  });
}

export default defineExtension('session-title', (pi: ExtensionAPI) => {
  registerAutomaticSessionTitles(pi);
});
