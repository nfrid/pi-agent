import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_TITLE_CONFIG } from './config.js';
import {
  buildSessionTitleHistory,
  generateSessionTitle,
  generateSessionTitleFromHistory,
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

  it('builds a bounded lite history without tool details or sliced messages', () => {
    const history = buildSessionTitleHistory(
      [
        {
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Build automatic titles.' }],
          },
        },
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'private reasoning' },
              {
                type: 'text',
                text: `An obsolete implementation detail ${'x'.repeat(120)}`,
              },
              { type: 'toolCall', name: 'read', arguments: { secret: true } },
            ],
          },
        },
        {
          type: 'message',
          message: {
            role: 'toolResult',
            content: [{ type: 'text', text: 'very large tool output' }],
          },
        },
        {
          type: 'message',
          message: {
            role: 'user',
            content: 'Also support history-based regeneration.',
          },
        },
      ],
      120,
    );

    expect(history).toContain('User:\nBuild automatic titles.');
    expect(history).toContain(
      'User:\nAlso support history-based regeneration.',
    );
    expect(history).toContain('[Earlier transcript turns omitted]');
    expect(history).not.toContain('obsolete implementation');
    expect(history).not.toContain('private reasoning');
    expect(history).not.toContain('tool output');
    expect(history?.length).toBeLessThanOrEqual(120);
  });

  it('never slices or substitutes an oversized initial request', () => {
    const initial = 'Keep this request whole '.repeat(10);
    expect(
      buildSessionTitleHistory(
        [
          {
            type: 'message',
            message: { role: 'user', content: initial },
          },
        ],
        100,
      ),
    ).toBeUndefined();
  });

  it('uses a history-specific prompt for regeneration', async () => {
    const complete = vi.fn(
      async (_model: unknown, _request: unknown, _options: unknown) => ({
        content: [{ type: 'text', text: 'Regenerate session titles' }],
      }),
    );
    const client = {
      find: vi.fn(() => ({
        provider: 'openai-codex',
        id: 'gpt-5.6-luna',
        api: 'openai-codex-responses',
        reasoning: true,
      })),
      complete,
    } as unknown as SessionTitleModelClient;

    await expect(
      generateSessionTitleFromHistory(
        client,
        [
          {
            type: 'message',
            message: { role: 'user', content: 'Add automatic titles.' },
          },
        ],
        new AbortController().signal,
        TEST_CONFIG,
      ),
    ).resolves.toBe('Regenerate session titles');
    const request = complete.mock.calls[0]?.[1] as { systemPrompt: string };
    expect(request.systemPrompt).toContain(
      'updated title for a coding session from its conversation so far',
    );
  });

  it('requests and preserves titles in the user’s language', async () => {
    const complete = vi.fn(
      async (_model: unknown, _request: unknown, _options: unknown) => ({
        content: [{ type: 'text', text: '  `Исправить названия сессий`  ' }],
      }),
    );
    const client = {
      find: vi.fn(() => ({
        provider: 'openai-codex',
        id: 'gpt-5.6-luna',
        api: 'openai-codex-responses',
        reasoning: true,
      })),
      complete,
    } as unknown as SessionTitleModelClient;

    await expect(
      generateSessionTitle(
        client,
        'Почему автозаголовки не работают?',
        new AbortController().signal,
        TEST_CONFIG,
      ),
    ).resolves.toBe('Исправить названия сессий');
    const request = complete.mock.calls[0]?.[1] as { systemPrompt: string };
    expect(request.systemPrompt).toContain(
      "same language and writing system as the user's request",
    );
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
