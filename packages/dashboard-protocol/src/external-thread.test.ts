import { describe, expect, it } from 'vitest';
import { parseExternalThreadCreateCommand } from './dashboard-api.js';

describe('external thread create contract', () => {
  it('accepts the bounded machine payload and keeps externalRef opaque', () => {
    expect(
      parseExternalThreadCreateCommand({
        externalRef: 'build:2026/09/04',
        title: 'Build dashboard',
        prompt: 'Run the build and report failures.',
        isolation: 'main',
      }),
    ).toMatchObject({ externalRef: 'build:2026/09/04', isolation: 'main' });
  });

  it('rejects extras, blank prompts/titles, and control characters in refs', () => {
    expect(() =>
      parseExternalThreadCreateCommand({
        externalRef: 'ref',
        title: 'Title',
        prompt: 'Prompt',
        mode: 'write',
      }),
    ).toThrow();
    for (const prompt of ['', '   ', '\n\t'])
      expect(() =>
        parseExternalThreadCreateCommand({
          externalRef: 'ref',
          title: 'Title',
          prompt,
        }),
      ).toThrow();
    expect(() =>
      parseExternalThreadCreateCommand({
        externalRef: 'bad\u0000ref',
        title: 'Title',
        prompt: 'Prompt',
      }),
    ).toThrow();
  });
});
