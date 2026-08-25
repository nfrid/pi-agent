import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_TITLE_CONFIG } from './config';
import {
  generateSessionTitle,
  registerAutomaticSessionTitles,
  sanitizeSessionTitle,
} from './index';

const TEST_CONFIG = { ...DEFAULT_SESSION_TITLE_CONFIG };

type Handler = (event: unknown, context: unknown) => unknown;

function createHarness(entries: readonly unknown[] = []) {
  const handlers = new Map<string, Handler>();
  const setSessionName = vi.fn((value: string) => {
    name = value;
  });
  let name: string | undefined;
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    getSessionName: () => name,
    setSessionName,
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: { getEntries: () => entries },
  };

  return {
    context,
    handlers,
    pi,
    setName(value: string | undefined) {
      name = value;
    },
    setSessionName,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('automatic session titles', () => {
  it('generates once in the background on the first turn', async () => {
    const harness = createHarness();
    const generate = vi.fn<typeof generateSessionTitle>(
      async () => 'Fix Session Titles',
    );
    registerAutomaticSessionTitles(harness.pi, generate, () => TEST_CONFIG);

    harness.handlers.get('session_start')?.({}, harness.context);
    expect(
      harness.handlers.get('before_agent_start')?.(
        { prompt: '  add automatic titles  ' },
        harness.context,
      ),
    ).toBeUndefined();
    harness.handlers.get('before_agent_start')?.(
      { prompt: 'second prompt' },
      harness.context,
    );
    await flushPromises();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[1]).toBe('add automatic titles');
    expect(harness.setSessionName).toHaveBeenCalledWith('Fix Session Titles');
  });

  it('does not overwrite a manual name that wins the generation race', async () => {
    const harness = createHarness();
    let resolveTitle: ((title: string) => void) | undefined;
    const generate = vi.fn<typeof generateSessionTitle>(
      () =>
        new Promise<string>((resolve) => {
          resolveTitle = resolve;
        }),
    );
    registerAutomaticSessionTitles(harness.pi, generate, () => TEST_CONFIG);

    harness.handlers.get('session_start')?.({}, harness.context);
    harness.handlers.get('before_agent_start')?.(
      { prompt: 'rename me' },
      harness.context,
    );
    harness.setName('My manual title');
    resolveTitle?.('Generated title');
    await flushPromises();

    expect(harness.setSessionName).not.toHaveBeenCalled();
  });

  it('skips named and resumed sessions', () => {
    const named = createHarness();
    named.setName('Existing name');
    const namedGenerate = vi.fn<typeof generateSessionTitle>(
      async () => 'Generated title',
    );
    registerAutomaticSessionTitles(named.pi, namedGenerate, () => TEST_CONFIG);
    named.handlers.get('session_start')?.({}, named.context);
    named.handlers.get('before_agent_start')?.(
      { prompt: 'new prompt' },
      named.context,
    );

    const resumed = createHarness([
      { type: 'message', message: { role: 'user', content: 'old prompt' } },
    ]);
    const resumedGenerate = vi.fn<typeof generateSessionTitle>(
      async () => 'Generated title',
    );
    registerAutomaticSessionTitles(
      resumed.pi,
      resumedGenerate,
      () => TEST_CONFIG,
    );
    resumed.handlers.get('session_start')?.({}, resumed.context);
    resumed.handlers.get('before_agent_start')?.(
      { prompt: 'continued prompt' },
      resumed.context,
    );

    expect(namedGenerate).not.toHaveBeenCalled();
    expect(resumedGenerate).not.toHaveBeenCalled();
  });

  it('aborts in-flight generation when the session shuts down', async () => {
    const harness = createHarness();
    let generationSignal: AbortSignal | undefined;
    const generate = vi.fn<typeof generateSessionTitle>(
      async (_ctx, _prompt, signal) => {
        generationSignal = signal;
        return 'Late title';
      },
    );
    registerAutomaticSessionTitles(harness.pi, generate, () => TEST_CONFIG);

    harness.handlers.get('session_start')?.({}, harness.context);
    harness.handlers.get('before_agent_start')?.(
      { prompt: 'title this' },
      harness.context,
    );
    harness.handlers.get('session_shutdown')?.({}, harness.context);
    await flushPromises();

    expect(generationSignal?.aborted).toBe(true);
    expect(harness.setSessionName).not.toHaveBeenCalled();
  });
});

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
    const context = {
      modelRegistry: {
        find: vi.fn(() => model),
        complete,
      },
    };

    await expect(
      generateSessionTitle(
        context as never,
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
    expect(context.modelRegistry.find).toHaveBeenCalledWith(
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
