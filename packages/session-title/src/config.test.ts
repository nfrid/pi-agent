import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_TITLE_CONFIG,
  parseSessionTitleConfig,
  parseSessionTitleSettings,
} from './config.js';

describe('session title configuration', () => {
  it('uses cheap low-reasoning defaults when the settings block is absent', () => {
    expect(DEFAULT_SESSION_TITLE_CONFIG.thinking).toBe('low');
    expect(parseSessionTitleSettings({ unrelated: true })).toEqual(
      DEFAULT_SESSION_TITLE_CONFIG,
    );
  });

  it('parses model, reasoning, limits, and editorial overrides', () => {
    expect(
      parseSessionTitleSettings({
        sessionTitle: {
          enabled: false,
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          thinking: 'off',
          timeoutMs: 12_000,
          maxInputChars: 4_000,
          maxOutputTokens: 80,
          maxLength: 42,
          instructions: 'Keep issue numbers when they identify the subject.',
        },
      }),
    ).toEqual({
      enabled: false,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      thinking: 'off',
      timeoutMs: 12_000,
      maxInputChars: 4_000,
      maxOutputTokens: 80,
      maxLength: 42,
      instructions: 'Keep issue numbers when they identify the subject.',
    });
  });

  it('rejects unknown, malformed, and out-of-range settings', () => {
    const parsed = parseSessionTitleConfig({
      provider: '',
      thinking: 'extreme',
      timeoutMs: 10,
      maxLength: 200,
      mystery: true,
    });

    expect(parsed.error).toContain('sessionTitle.mystery is not supported');
    expect(parsed.error).toContain('provider must be a non-empty');
    expect(parsed.error).toContain('thinking must be one of');
    expect(parsed.error).toContain('timeoutMs must be an integer');
    expect(parsed.error).toContain('maxLength must be an integer');
    expect(parsed.provider).toBe(DEFAULT_SESSION_TITLE_CONFIG.provider);
    expect(parsed.thinking).toBe(DEFAULT_SESSION_TITLE_CONFIG.thinking);
  });
});
