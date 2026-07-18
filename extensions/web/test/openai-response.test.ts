import { describe, expect, it } from 'vitest';
import {
  extractAnswer,
  extractSearchResults,
  parseOpenAIResponse,
} from '../openai-response';

describe('OpenAI response parsing', () => {
  it('parses SSE output items when the completed response has no output', async () => {
    const item = {
      type: 'message',
      content: [{ type: 'output_text', text: 'SSE answer' }],
    };
    const response = new Response(
      `data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n` +
        `data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n` +
        'data: [DONE]\n',
    );
    const parsed = await parseOpenAIResponse(response);
    expect(parsed.output).toEqual([item]);
  });

  it('extracts, cleans, deduplicates, and caps citation sources', () => {
    const annotations = Array.from({ length: 25 }, (_, index) => ({
      type: 'url_citation',
      start_index: 0,
      end_index: 6,
      url: `https://example.com/${index}?utm_source=openai`,
      title: `Source ${index}`,
    }));
    annotations.push({ ...annotations[0] });
    const output = [
      {
        type: 'message',
        content: [{ text: 'Answer text', annotations }],
      },
    ];
    expect(extractAnswer(output)).toBe('Answer text');
    const results = extractSearchResults(output, 25);
    expect(results).toHaveLength(20);
    expect(results[0]).toEqual({
      title: 'Source 0',
      url: 'https://example.com/0',
      snippet: 'Answer text',
    });
  });

  it('falls back to web-search source groups', () => {
    expect(
      extractSearchResults(
        [
          {
            type: 'web_search_call',
            action: {
              sources: [{ url: 'https://example.com', title: 'Example' }],
            },
          },
        ],
        undefined,
      ),
    ).toEqual([{ title: 'Example', url: 'https://example.com/', snippet: '' }]);
  });

  it('rejects invalid JSON and empty SSE output', async () => {
    await expect(parseOpenAIResponse(new Response('{invalid'))).rejects.toThrow(
      'OpenAI API returned invalid JSON',
    );
    await expect(
      parseOpenAIResponse(new Response('data: [DONE]\n')),
    ).rejects.toThrow('OpenAI API returned no parseable response output');
  });
});
