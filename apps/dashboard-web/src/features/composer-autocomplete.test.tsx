import { describe, expect, it } from 'vitest';
import {
  type ComposerCommandOption,
  commandSourceLabel,
  composerCommandSuggestions,
  composerCompletionToken,
  composerFileSuggestionOptions,
  fuzzyCommandScore,
} from './composer-autocomplete';

const commands: ComposerCommandOption[] = [
  {
    name: 'skill:playwright-cli',
    description: 'Automate a browser',
    source: 'skill',
  },
  {
    name: 'review',
    description: 'Review changes',
    argumentHint: '[scope]',
    source: 'prompt',
  },
  {
    name: 'reload',
    description: 'Reload resources',
    source: 'builtin',
  },
  {
    name: 'skill:harness-feedback',
    description: 'Capture harness feedback',
    source: 'skill',
  },
];

function token(text: string, cursor = text.length) {
  return composerCompletionToken(text, cursor);
}

describe('composer autocomplete', () => {
  it('recognizes leading slash commands and caret-local file and skill tokens', () => {
    expect(token('/ski')).toMatchObject({
      kind: 'command',
      prefix: '/ski',
      query: 'ski',
      start: 0,
      end: 4,
    });
    expect(token('please /ski')).toBeUndefined();
    expect(token('/skill:playwright-cli now')).toBeUndefined();
    expect(token('foo @src/uti bar', 12)).toMatchObject({
      kind: 'file',
      prefix: '@src/uti',
      query: 'src/uti',
      start: 4,
      end: 12,
    });
    expect(token('use $play and $other', 9)).toMatchObject({
      kind: 'skill',
      prefix: '$play',
      query: 'play',
      start: 4,
      end: 9,
    });
  });

  it('ranks commands separately from skills and records highlighted matches', () => {
    const slash = composerCommandSuggestions(commands, token('/RE'));
    expect(slash.map((suggestion) => suggestion.label)).toEqual([
      '/reload',
      '/review',
    ]);
    expect(slash[0]?.matches).toEqual([1, 2]);
    expect(
      composerCommandSuggestions(commands, token('$play')).map(
        (suggestion) => suggestion.label,
      ),
    ).toEqual(['$playwright-cli']);
    expect(
      composerCommandSuggestions(commands, token('$fee')).map(
        (suggestion) => suggestion.label,
      ),
    ).toEqual(['$harness-feedback']);
    expect(fuzzyCommandScore('skill:harness-feedback', 'fee')).toBeDefined();
    expect(fuzzyCommandScore('skill:harness-feedback', 'xyz')).toBeUndefined();
  });

  it('keeps explicit file spelling in completion values', () => {
    expect(
      composerFileSuggestionOptions(
        [
          {
            value: '../shared/file.ts',
            label: 'file.ts',
            directory: false,
          },
          {
            value: '.ignoredDir/nested/',
            label: 'nested/',
            directory: true,
          },
        ],
        token('foo @../shared/fi bar', 17),
      ).map((suggestion) => suggestion.value),
    ).toEqual(['@../shared/file.ts', '@.ignoredDir/nested/']);
  });

  it('uses concise source labels', () => {
    expect(commandSourceLabel('builtin', 'command')).toBe('Command');
    expect(commandSourceLabel('prompt', 'command')).toBe('Prompt');
    expect(commandSourceLabel('skill', 'skill')).toBe('Skill');
    expect(commandSourceLabel(undefined, 'file')).toBe('File');
  });
});
