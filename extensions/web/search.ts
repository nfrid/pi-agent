import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { searchWithExa } from './exa';
import { isOpenAISearchAvailable, searchWithOpenAI } from './openai-search';
import type { SearchOptions, SearchResponseWithProvider } from './types';
import { throwIfAborted } from './utils';

export async function search(
  query: string,
  options: SearchOptions = {},
  ctx?: ExtensionContext,
): Promise<SearchResponseWithProvider> {
  if (await isOpenAISearchAvailable(ctx)) {
    try {
      return {
        ...(await searchWithOpenAI(query, options, ctx)),
        provider: 'openai',
      };
    } catch {
      throwIfAborted(options.signal);
      // Exa remains a zero-configuration fallback when Codex/OpenAI search fails.
    }
  }
  throwIfAborted(options.signal);
  const result = await searchWithExa(query, options);
  if (!result) throw new Error('Exa returned no search results');
  return { ...result, provider: 'exa' };
}
