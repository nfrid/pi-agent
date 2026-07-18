import { describe, expect, it } from 'vitest';
import { buildRule, formatRules, parseManifest } from './manifest';

function manifest(rule: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, rules: [rule] });
}

const validRule = {
  id: 'rule',
  scope: 'src/',
  intents: ['edit', 'write'],
  instructionFiles: ['a.md', 'b.md'],
  critical: true,
};

describe('scoped instruction manifest policy', () => {
  it('strictly validates schema, paths, and duplicate values', () => {
    expect(() =>
      parseManifest(manifest({ ...validRule, extra: true })),
    ).toThrow('must contain exactly');
    expect(() =>
      parseManifest(
        manifest({ ...validRule, instructionFiles: ['../outside.md'] }),
      ),
    ).toThrow('traversal segment');
    expect(() =>
      parseManifest(manifest({ ...validRule, intents: ['edit', 'edit'] })),
    ).toThrow('invalid or duplicate intents');
  });

  it('preserves ordered text and rule hash compatibility', () => {
    const [parsed] = parseManifest(manifest(validRule));
    const rule = buildRule(parsed, [
      { path: 'a.md', text: 'alpha' },
      { path: 'b.md', text: 'beta' },
    ]);
    expect(rule.texts.map((text) => text.hash)).toEqual([
      '8ed3f6ad685b',
      'f44e64e75f39',
    ]);
    expect(rule.hash).toBe('6b375b629968');
    expect(formatRules([rule])).toContain(
      '--- a.md [8ed3f6ad685b] ---\n\nalpha\n\n--- b.md [f44e64e75f39] ---',
    );
  });
});
