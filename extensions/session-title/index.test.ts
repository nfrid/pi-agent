import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_TITLE_CONFIG } from './config';
import {
  type generateSessionTitle,
  registerAutomaticSessionTitles,
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

    harness.handlers.get('session_start')?.({ reason: 'new' }, harness.context);
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

    harness.handlers.get('session_start')?.({ reason: 'new' }, harness.context);
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
    named.handlers.get('session_start')?.({ reason: 'new' }, named.context);
    named.handlers.get('before_agent_start')?.(
      { prompt: 'new prompt' },
      named.context,
    );

    const resumed = createHarness();
    const resumedGenerate = vi.fn<typeof generateSessionTitle>(
      async () => 'Generated title',
    );
    registerAutomaticSessionTitles(
      resumed.pi,
      resumedGenerate,
      () => TEST_CONFIG,
    );
    resumed.handlers.get('session_start')?.(
      { reason: 'resume' },
      resumed.context,
    );
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

    harness.handlers.get('session_start')?.({ reason: 'new' }, harness.context);
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
