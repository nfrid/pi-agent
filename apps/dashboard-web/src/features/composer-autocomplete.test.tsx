import { describe, expect, it } from 'vitest';
import {
  type ComposerCommandOption,
  commandSourceLabel,
  composerCommandQuery,
  composerCommandSuggestions,
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

describe('composer slash autocomplete', () => {
  it('opens only for a leading command token', () => {
    expect(composerCommandQuery('/')).toBe('');
    expect(composerCommandQuery('/ski')).toBe('ski');
    expect(composerCommandQuery('please /ski')).toBeUndefined();
    expect(composerCommandQuery('/skill:playwright-cli now')).toBeUndefined();
    expect(composerCommandQuery('//nested')).toBeUndefined();
  });

  it('ranks prefix and fuzzy matches while keeping results bounded', () => {
    expect(composerCommandSuggestions(commands, '/RE')).toEqual([
      commands[2],
      commands[1],
      commands[3],
    ]);
    expect(composerCommandSuggestions(commands, '/skill:p')).toEqual([
      commands[0],
    ]);
    expect(composerCommandSuggestions(commands, '/fee')).toEqual([commands[3]]);
    expect(fuzzyCommandScore('skill:harness-feedback', 'fee')).toBeDefined();
    expect(fuzzyCommandScore('skill:harness-feedback', 'xyz')).toBeUndefined();
    expect(composerCommandSuggestions(commands, 'review')).toEqual([]);
    expect(
      composerCommandSuggestions(
        Array.from({ length: 20 }, (_, index) => ({
          name: `command-${String(index).padStart(2, '0')}`,
          source: 'builtin' as const,
        })),
        '/',
      ),
    ).toHaveLength(8);
  });

  it('uses concise source labels', () => {
    expect(commandSourceLabel('builtin')).toBe('Command');
    expect(commandSourceLabel('prompt')).toBe('Prompt');
    expect(commandSourceLabel('skill')).toBe('Skill');
  });
});
