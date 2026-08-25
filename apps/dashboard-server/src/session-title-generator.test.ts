import type { SessionTitleModelClient } from '@pi-agent/session-title';
import { DEFAULT_SESSION_TITLE_CONFIG } from '@pi-agent/session-title';
import { describe, expect, it, vi } from 'vitest';
import {
  createDashboardSessionTitleGenerator,
  readLiteSessionTitleHistory,
} from './session-title-generator.js';

describe('dashboard session title generator', () => {
  it('reads the selected branch while retaining bounded lite title messages', async () => {
    const readSelectedBranchEntries = vi.fn(
      async (
        _id: string,
        _leafId: string | undefined,
        selector: (entry: unknown) => boolean,
        options: {
          projectEntry: (entry: unknown) => { entry: unknown };
        },
      ) => {
        const entries = [
          {
            type: 'message',
            message: { role: 'toolResult', content: 'large tool output' },
          },
          {
            type: 'message',
            message: { role: 'user', content: 'Original request' },
          },
          {
            type: 'message',
            message: { role: 'user', content: 'Off-branch request' },
          },
        ];
        expect(selector(entries[1])).toBe(true);
        expect(selector(entries[1])).toBe(true);
        return {
          entries: entries
            .filter(selector)
            .map((entry) => options.projectEntry(entry).entry),
          leafId: 'selected-leaf',
          entriesTruncated: false,
        };
      },
    );
    const readEntries = vi.fn(async () => ({
      entries: [
        {
          type: 'message',
          message: { role: 'assistant', content: 'Recent response' },
        },
        {
          type: 'message',
          message: { role: 'user', content: 'Newest request' },
        },
        {
          type: 'message',
          message: { role: 'toolResult', content: 'large tool output' },
        },
      ],
    }));

    await expect(
      readLiteSessionTitleHistory(
        { readEntries, readSelectedBranchEntries } as never,
        'session-1',
      ),
    ).resolves.toEqual([
      { role: 'user', content: 'Original request' },
      { role: 'assistant', content: 'Recent response' },
      { role: 'user', content: 'Newest request' },
    ]);
    expect(readSelectedBranchEntries).toHaveBeenCalledWith(
      'session-1',
      undefined,
      expect.any(Function),
      expect.objectContaining({ resolveLatestLeaf: true }),
    );
    expect(readEntries).toHaveBeenCalledWith(
      'session-1',
      undefined,
      'selected-leaf',
    );
  });

  it('lazily reuses authenticated model access across titles', async () => {
    const client = {
      find: vi.fn(() => ({
        provider: 'openai-codex',
        id: 'gpt-5.6-luna',
        api: 'openai-codex-responses',
        reasoning: true,
      })),
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'First generated title' }],
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Second generated title' }],
        }),
    } as unknown as SessionTitleModelClient;
    const createClient = vi.fn(async () => client);
    const generator = createDashboardSessionTitleGenerator({
      createClient,
      loadConfig: () => ({ ...DEFAULT_SESSION_TITLE_CONFIG }),
    });

    await expect(generator.generate('First prompt')).resolves.toBe(
      'First generated title',
    );
    await expect(
      generator.regenerate([
        {
          type: 'message',
          message: { role: 'user', content: 'Second prompt' },
        },
      ]),
    ).resolves.toBe('Second generated title');
    expect(createClient).toHaveBeenCalledOnce();
  });

  it('does not initialize model access when disabled and falls back on failure', async () => {
    const createClient = vi.fn(async () => {
      throw new Error('auth unavailable');
    });
    const warn = vi.fn();
    const disabled = createDashboardSessionTitleGenerator({
      createClient,
      loadConfig: () => ({
        ...DEFAULT_SESSION_TITLE_CONFIG,
        enabled: false,
      }),
      warn,
    });
    await expect(disabled.generate('Prompt')).resolves.toBeUndefined();
    expect(createClient).not.toHaveBeenCalled();

    const failing = createDashboardSessionTitleGenerator({
      createClient,
      loadConfig: () => ({ ...DEFAULT_SESSION_TITLE_CONFIG }),
      warn,
    });
    await expect(failing.generate('Prompt')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Automatic dashboard session title generation failed.',
      expect.any(Error),
    );
  });
});
