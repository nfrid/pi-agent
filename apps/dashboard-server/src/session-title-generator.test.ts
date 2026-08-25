import type { SessionTitleModelClient } from '@pi-agent/session-title';
import { DEFAULT_SESSION_TITLE_CONFIG } from '@pi-agent/session-title';
import { describe, expect, it, vi } from 'vitest';
import { createDashboardSessionTitleGenerator } from './session-title-generator.js';

describe('dashboard session title generator', () => {
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
    const generate = createDashboardSessionTitleGenerator({
      createClient,
      loadConfig: () => ({ ...DEFAULT_SESSION_TITLE_CONFIG }),
    });

    await expect(generate('First prompt')).resolves.toBe(
      'First generated title',
    );
    await expect(generate('Second prompt')).resolves.toBe(
      'Second generated title',
    );
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
    await expect(disabled('Prompt')).resolves.toBeUndefined();
    expect(createClient).not.toHaveBeenCalled();

    const failing = createDashboardSessionTitleGenerator({
      createClient,
      loadConfig: () => ({ ...DEFAULT_SESSION_TITLE_CONFIG }),
      warn,
    });
    await expect(failing('Prompt')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Automatic dashboard session title generation failed.',
      expect.any(Error),
    );
  });
});
