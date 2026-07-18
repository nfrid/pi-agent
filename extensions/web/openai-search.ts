import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  extractAccountId,
  isCodexJwt,
  isOpenAISearchAvailable,
  OPENAI_CONFIG_PATH,
  resolveOpenAIAuth,
} from './openai-auth';
import {
  extractAnswer,
  extractSearchResults,
  parseOpenAIResponse,
} from './openai-response';
import type { SearchOptions, SearchResponse } from './types';
import { fetchWithRetry, readResponseTextLimited } from './utils';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const SEARCH_TIMEOUT_MS = 60_000;

export { isOpenAISearchAvailable, resolveOpenAIAuth };

interface NormalizedDomainFilters {
  allowedDomains?: string[];
  blockedDomains?: string[];
}

function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith('-')) input = input.slice(1).trim();
  if (!input) return null;
  try {
    const parsed = input.includes('://')
      ? new URL(input)
      : new URL(`https://${input}`);
    input = parsed.hostname;
  } catch {
    input = input.split('/')[0]?.split(':')[0] ?? '';
  }
  input = input.replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function normalizeDomainFilters(
  domainFilter: string[] | undefined,
): NormalizedDomainFilters | null {
  if (!domainFilter?.length) return null;

  const allowedDomains: string[] = [];
  const blockedDomains: string[] = [];
  for (const raw of domainFilter) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    const target = raw.trim().startsWith('-') ? blockedDomains : allowedDomains;
    if (!target.includes(domain)) target.push(domain);
  }

  return allowedDomains.length > 0 || blockedDomains.length > 0
    ? {
        ...(allowedDomains.length > 0
          ? { allowedDomains: allowedDomains.slice(0, 100) }
          : {}),
        ...(blockedDomains.length > 0
          ? { blockedDomains: blockedDomains.slice(0, 100) }
          : {}),
      }
    : null;
}

function buildInstructions(options: SearchOptions): string {
  const lines = [
    'Search the web and return a concise answer grounded only in the web results.',
    'Include clickable source citations in the response text when possible.',
  ];

  if (options.recencyFilter) {
    const labels: Record<string, string> = {
      day: 'past 24 hours',
      week: 'past week',
      month: 'past month',
      year: 'past year',
    };
    lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
  }

  if (
    typeof options.numResults === 'number' &&
    Number.isFinite(options.numResults) &&
    options.numResults > 0
  ) {
    lines.push(
      `Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`,
    );
  }

  const filters = normalizeDomainFilters(options.domainFilter);
  if (filters?.allowedDomains?.length)
    lines.push(`Only use sources from: ${filters.allowedDomains.join(', ')}.`);
  if (filters?.blockedDomains?.length)
    lines.push(
      `Do not use sources from: ${filters.blockedDomains.join(', ')}.`,
    );

  return lines.join(' ');
}

function buildWebSearchTool(options: SearchOptions): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: 'web_search' };
  const filters = normalizeDomainFilters(options.domainFilter);
  if (filters) {
    tool.filters = {
      ...(filters.allowedDomains
        ? { allowed_domains: filters.allowedDomains }
        : {}),
    };
  }
  return tool;
}

export async function searchWithOpenAI(
  query: string,
  options: SearchOptions = {},
  ctx?: ExtensionContext,
): Promise<SearchResponse> {
  const auth = await resolveOpenAIAuth(ctx);
  if (!auth) {
    throw new Error(
      'OpenAI web search unavailable. Either:\n' +
        '  1. Use /login to sign in with a Codex subscription\n' +
        `  2. Create ${OPENAI_CONFIG_PATH} with { "openaiApiKey": "your-key" }\n` +
        '  3. Set OPENAI_API_KEY environment variable',
    );
  }

  const headers: Record<string, string> = {
    ...auth.headers,
    Authorization: `Bearer ${auth.apiKey}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'responses=experimental',
  };
  const useCodexEndpoint =
    auth.provider === 'openai-codex' || isCodexJwt(auth.apiKey);
  if (useCodexEndpoint) {
    const accountId = extractAccountId(auth.apiKey);
    if (accountId) headers['chatgpt-account-id'] = accountId;
    headers.originator = 'pi';
  }

  const body = {
    model: auth.model,
    instructions: buildInstructions(options),
    input: [{ role: 'user', content: [{ type: 'input_text', text: query }] }],
    tools: [buildWebSearchTool(options)],
    include: ['web_search_call.action.sources'],
    store: false,
    stream: true,
    tool_choice: 'required' as const,
    parallel_tool_calls: true,
  };
  const response = await fetchWithRetry(
    useCodexEndpoint ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal
        ? AbortSignal.any([
            AbortSignal.timeout(SEARCH_TIMEOUT_MS),
            options.signal,
          ])
        : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const errorText = await readResponseTextLimited(response, 64 * 1024);
    throw new Error(
      `OpenAI API error ${response.status}: ${errorText.slice(0, 300)}`,
    );
  }

  const parsed = await parseOpenAIResponse(response);
  const output = Array.isArray(parsed.output) ? parsed.output : [];
  const answer = extractAnswer(output);
  const results = extractSearchResults(output, options.numResults);

  if (!answer && results.length === 0) {
    throw new Error('OpenAI web_search returned no answer or sources');
  }

  return { answer, results };
}
