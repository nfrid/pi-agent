export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  numResults?: number;
  recencyFilter?: 'day' | 'week' | 'month' | 'year';
  domainFilter?: string[];
  includeContent?: boolean;
  signal?: AbortSignal;
}

export interface SearchResponse {
  answer: string;
  results: SearchResult[];
  inlineContent?: import('./extract').ExtractedContent[];
}

export interface SearchResponseWithProvider extends SearchResponse {
  provider: 'openai' | 'exa';
}
