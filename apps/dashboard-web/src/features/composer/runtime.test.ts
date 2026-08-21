import { describe, expect, it } from 'vitest';
import {
  composerCommandType,
  composerIsDisabled,
  composerMode,
  composerSubmissionPolicy,
  contextIndicatorData,
  dormantResumeMetadata,
  formatContextTokens,
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
        { provider: 'test', model: 'vision', supportsImages: true },
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
      model: { provider: 'test', model: 'vision' },
      thinking: 'high',
      contextTokens: 4200,
      supportsImages: true,
    });
    expect(
      dormantResumeMetadata(
        { lastKnownModel: { provider: 'unknown', model: 'vision' } } as never,
        [runtime],
      ).supportsImages,
    ).toBe(false);
    expect(dormantResumeMetadata(undefined, [runtime]).supportsImages).toBe(
      false,
    );
  });

  it('builds resume requests and checks image capability explicitly', () => {
    expect(
      resumeRuntimeRequest('workspace-1', 'session-1', 'resume me'),
    ).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      initialPrompt: 'resume me',
    });
    expect(resumeRuntimeRequest('workspace-1', 'session-1')).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    });
    expect(resumeRuntimeRequest(undefined, 'session-1')).toBeUndefined();
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
