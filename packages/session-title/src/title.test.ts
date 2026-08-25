import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_TITLE_CONFIG } from './config.js';
import {
  generateSessionTitle,
  type SessionTitleModelClient,
  sanitizeSessionTitle,
} from './title.js';

const TEST_CONFIG = { ...DEFAULT_SESSION_TITLE_CONFIG };

describe('session title generation', () => {
  it('uses the configured model, reasoning, limits, and instructions', async () => {
    const complete = vi.fn(
      async (_model: unknown, _request: unknown, _options: unknown) => ({
        content: [{ type: 'text', text: '  "Improve session naming."  ' }],
      }),
    );
    const model = {
      provider: 'custom-codex',
      id: 'cheap-title-model',
      api: 'openai-codex-responses',
      reasoning: true,
    };
    const client = {
      find: vi.fn(() => model),
      complete,
    } as unknown as SessionTitleModelClient;

    await expect(
      generateSessionTitle(
        client,
        'x'.repeat(9_000),
        new AbortController().signal,
        {
          ...TEST_CONFIG,
          provider: 'custom-codex',
          model: 'cheap-title-model',
          maxInputChars: 123,
          maxOutputTokens: 32,
          maxLength: 24,
          instructions: 'Keep ticket IDs.',
        },
      ),
    ).resolves.toBe('Improve session naming');
    expect(client.find).toHaveBeenCalledWith(
      'custom-codex',
      'cheap-title-model',
    );
    const request = complete.mock.calls[0]?.[1] as {
      systemPrompt: string;
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(request.systemPrompt).toContain('no more than 24 characters');
    expect(request.systemPrompt).toContain('Keep ticket IDs.');
    expect(request.messages[0]?.content[0]?.text).toHaveLength(123);
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      cacheRetention: 'none',
      maxTokens: 32,
      reasoningEffort: 'low',
    });
  });

  it('normalizes model output and rejects empty titles', () => {
    expect(sanitizeSessionTitle('  `Fix   title generation!`  ')).toBe(
      'Fix title generation',
    );
    expect(sanitizeSessionTitle('  \n  ')).toBeUndefined();
    expect(
      sanitizeSessionTitle(
        'Reconnect failures after restart because the session state does not recover',
      ),
    ).toBe('Reconnect failures after restart because the se...');
  });
});
