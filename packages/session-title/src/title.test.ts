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
    const streamSimple = vi.fn(
      (_model: unknown, _request: unknown, _options: unknown) => ({
        result: async () => ({
          content: [{ type: 'text', text: '  "Improve session naming."  ' }],
        }),
      }),
    );
    const model = {
      provider: 'custom-codex',
      id: 'cheap-title-model',
      api: 'openai-responses',
      reasoning: true,
    };
    const client = {
      find: vi.fn(() => model),
      streamSimple,
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
    const request = streamSimple.mock.calls[0]?.[1] as {
      systemPrompt: string;
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(request.systemPrompt).toContain('no more than 24 characters');
    expect(request.systemPrompt).toContain('Keep ticket IDs.');
    expect(request.messages[0]?.content[0]?.text).toHaveLength(123);
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({
      cacheRetention: 'none',
      maxTokens: 32,
      reasoning: 'low',
    });
  });

  it('omits unsupported off reasoning and reuses the abort signal for retries', async () => {
    const controller = new AbortController();
    const optionsSeen: Array<Record<string, unknown>> = [];
    const streamSimple = vi
      .fn()
      .mockImplementationOnce(
        (
          _model: unknown,
          _request: unknown,
          options: Record<string, unknown>,
        ) => {
          optionsSeen.push(options);
          return {
            result: async () => ({
              content: [{ type: 'text', text: 'Finance sync' }],
            }),
          };
        },
      )
      .mockImplementationOnce(
        (
          _model: unknown,
          _request: unknown,
          options: Record<string, unknown>,
        ) => {
          optionsSeen.push(options);
          return {
            result: async () => ({
              content: [{ type: 'text', text: 'Завершить finance sync' }],
            }),
          };
        },
      );
    const client = {
      find: vi.fn(() => ({
        provider: 'openai',
        id: 'title-model',
        api: 'openai-responses',
        reasoning: true,
      })),
      streamSimple,
    } as unknown as SessionTitleModelClient;

    await expect(
      generateSessionTitle(
        client,
        'мы провели finance sync, теперь надо закончить настройку',
        controller.signal,
        { ...TEST_CONFIG, thinking: 'off' },
      ),
    ).resolves.toBe('Завершить finance sync');

    expect(optionsSeen).toHaveLength(2);
    for (const options of optionsSeen) {
      expect(options).not.toHaveProperty('reasoning');
      expect(options.signal).toBe(controller.signal);
    }
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
    const streamSimple = vi.fn(
      (_model: unknown, _request: unknown, _options: unknown) => ({
        result: async () => ({
          content: [{ type: 'text', text: 'Regenerate session titles' }],
        }),
      }),
    );
    const client = {
      find: vi.fn(() => ({
        provider: 'openai',
        id: 'gpt-6-luna',
        api: 'openai-responses',
        reasoning: true,
      })),
      streamSimple,
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
    const request = streamSimple.mock.calls[0]?.[1] as {
      systemPrompt: string;
    };
    expect(request.systemPrompt).toContain(
      'updated title for a coding session from its conversation so far',
    );
  });

  it('enforces Cyrillic output for predominantly Cyrillic requests', async () => {
    const streamSimple = vi
      .fn()
      .mockImplementationOnce(() => ({
        result: async () => ({
          content: [{ type: 'text', text: '- - - Finance sync' }],
        }),
      }))
      .mockImplementationOnce(() => ({
        result: async () => ({
          content: [
            { type: 'text', text: '  `Завершить настройку finance`  ' },
          ],
        }),
      }));
    const client = {
      find: vi.fn(() => ({
        provider: 'openai',
        id: 'gpt-6-luna',
        api: 'openai-responses',
        reasoning: true,
      })),
      streamSimple,
    } as unknown as SessionTitleModelClient;

    await expect(
      generateSessionTitle(
        client,
        'мы реализовали finance и провели sync, теперь надо закончить настройку',
        new AbortController().signal,
        TEST_CONFIG,
      ),
    ).resolves.toBe('Завершить настройку finance');
    expect(streamSimple).toHaveBeenCalledTimes(2);
    const request = streamSimple.mock.calls[0]?.[1] as {
      systemPrompt: string;
    };
    expect(request.systemPrompt).toContain(
      'This request is predominantly Cyrillic',
    );
    const retry = streamSimple.mock.calls[1]?.[1] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(retry.messages[0]?.content[0]?.text).toContain(
      'The title must contain Cyrillic words',
    );
  });

  it('normalizes model output and rejects empty titles', () => {
    expect(sanitizeSessionTitle('  `Fix   title generation!`  ')).toBe(
      'Fix title generation',
    );
    expect(sanitizeSessionTitle('- - - Finance sync')).toBe('Finance sync');
    expect(sanitizeSessionTitle('  \n  ')).toBeUndefined();
    expect(
      sanitizeSessionTitle(
        'Reconnect failures after restart because the session state does not recover',
      ),
    ).toBe('Reconnect failures after restart because the se...');
  });
});
