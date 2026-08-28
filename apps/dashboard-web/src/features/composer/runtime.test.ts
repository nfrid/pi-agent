import { describe, expect, it } from 'vitest';
import {
  composerCommandType,
  composerIsDisabled,
  composerMode,
  composerSubmissionPolicy,
  contextIndicatorData,
  dormantContextUsage,
  dormantResumeMetadata,
  draftModelSupportsImages,
  formatContextTokens,
  modelSupportsImages,
  resumeRuntimeRequest,
  runtimeSupportsImages,
} from './runtime';

describe('composer runtime model', () => {
  it('formats context usage at compact warning thresholds', () => {
    expect(formatContextTokens(950)).toBe('950');
    expect(formatContextTokens(12_400)).toBe('12.4k');
    expect(formatContextTokens(1_050_000)).toBe('1.1m');
    expect(
      contextIndicatorData({
        tokens: 136_000,
        contextWindow: 272_000,
        percent: 50,
      }),
    ).toEqual({ percent: 50, text: '50% [136k/272k]', level: 'warning' });
    expect(
      contextIndicatorData({
        tokens: null,
        contextWindow: 272_000,
        percent: null,
      }),
    ).toEqual({ percent: undefined, text: '?% [?/272k]', level: 'normal' });
    expect(contextIndicatorData({ tokens: 4200, contextWindow: 0 })).toEqual({
      percent: undefined,
      text: '?% [4.2k/?]',
      level: 'normal',
    });
  });

  it('routes explicit settled background waiting as a prompt', () => {
    const runtime = {
      runtimeId: 'runtime-1',
      liveState: 'working',
      online: true,
      session: { id: 'session-1', entries: [] },
      extensionSurfaces: [
        {
          id: 'runtime.settled-background',
          rendererId: 'runtime.settled-background',
          viewModel: { version: 1, count: 2 },
        },
      ],
    } as never;
    expect(composerMode(runtime)).toBe('prompt');
    expect(composerCommandType(runtime, 'prompt')).toBe('prompt');
    expect(composerSubmissionPolicy(runtime, 'prompt', false)).toEqual({
      commandType: 'prompt',
      queues: false,
    });
    expect(composerIsDisabled(runtime)).toBe(false);
  });

  it('resolves indexed metadata before configured defaults and fails closed for images', () => {
    const runtime = {
      modelCatalog: [
        {
          provider: 'test',
          model: 'vision',
          contextWindow: 272_000,
          supportsImages: true,
        },
        { provider: 'test', model: 'text', supportsImages: false },
      ],
      thinkingLevels: ['low'],
    } as never;
    expect(
      dormantResumeMetadata(
        {
          lastKnownModel: { provider: 'test', model: 'vision' },
          lastKnownThinking: 'high',
          lastKnownContextTokens: 4200,
        } as never,
        [runtime],
      ),
    ).toMatchObject({
      model: {
        provider: 'test',
        model: 'vision',
        contextWindow: 272_000,
      },
      thinking: 'high',
      contextTokens: 4200,
    });
    expect(
      modelSupportsImages({ provider: 'unknown', model: 'vision' }, [runtime]),
    ).toBe(false);
    expect(
      modelSupportsImages({ provider: 'test', model: 'vision' }, [runtime]),
    ).toBe(true);
  });

  it('enables draft images for unknown capability but not explicit false', () => {
    expect(
      draftModelSupportsImages({ provider: 'test', model: 'unknown' }, []),
    ).toBe(true);
    expect(
      draftModelSupportsImages({ provider: 'test', model: 'text' }, [
        {
          modelCatalog: [
            { provider: 'test', model: 'text', supportsImages: false },
          ],
        } as never,
      ]),
    ).toBe(false);
    expect(
      draftModelSupportsImages({ provider: 'test', model: 'current' }, [
        {
          model: {
            provider: 'test',
            model: 'current',
            supportsImages: false,
          },
        } as never,
      ]),
    ).toBe(false);
    expect(
      draftModelSupportsImages({ provider: 'test', model: 'unknown' }, [
        {
          modelCatalog: [
            { provider: 'test', model: 'other', supportsImages: false },
          ],
        } as never,
      ]),
    ).toBe(true);
  });

  it('builds resume requests and checks image capability explicitly', () => {
    expect(
      resumeRuntimeRequest(
        'project-1',
        'checkout-1',
        'session-1',
        'resume me',
        { provider: 'test', model: 'careful', thinking: 'high' },
      ),
    ).toEqual({
      projectId: 'project-1',
      checkoutId: 'checkout-1',
      sessionId: 'session-1',
      initialPrompt: 'resume me',
      model: { provider: 'test', model: 'careful', thinking: 'high' },
    });
    expect(
      resumeRuntimeRequest('project-1', 'checkout-1', 'session-1'),
    ).toEqual({
      projectId: 'project-1',
      checkoutId: 'checkout-1',
      sessionId: 'session-1',
    });
    expect(
      resumeRuntimeRequest(undefined, 'checkout-1', 'session-1'),
    ).toBeUndefined();
    expect(
      dormantContextUsage(
        { lastKnownContextTokens: 42 } as never,
        { provider: 'test', model: 'careful' },
        [
          {
            model: { provider: 'test', model: 'careful' },
            contextUsage: { tokens: 80, contextWindow: 100, percent: 80 },
          } as never,
        ],
      ),
    ).toEqual({ tokens: 42, contextWindow: 100, percent: 42 });
    expect(
      dormantContextUsage(
        { lastKnownContextTokens: 136_000 } as never,
        {
          provider: 'test',
          model: 'careful',
          contextWindow: 272_000,
        },
        [],
      ),
    ).toEqual({ tokens: 136_000, contextWindow: 272_000, percent: 50 });
    expect(
      dormantContextUsage(
        { lastKnownContextTokens: 42 } as never,
        undefined,
        [],
      ),
    ).toEqual({ tokens: 42, contextWindow: 0, percent: null });
    expect(
      runtimeSupportsImages({
        model: { provider: 'test', model: 'vision', supportsImages: true },
      } as never),
    ).toBe(true);
    expect(
      runtimeSupportsImages({
        model: { provider: 'test', model: 'vision' },
      } as never),
    ).toBe(false);
  });
});
