import { describe, expect, it } from 'vitest';
import {
  contextIndicatorData,
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

  it('builds resume requests and checks image capability explicitly', () => {
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
