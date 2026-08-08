import { describe, expect, it } from 'vitest';
import {
  type ComposerCommandOption,
  commandSourceLabel,
  composerCommandQuery,
  composerCommandSuggestions,
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
];

describe('composer slash autocomplete', () => {
  it('opens only for a leading command token', () => {
    expect(composerCommandQuery('/')).toBe('');
    expect(composerCommandQuery('/ski')).toBe('ski');
    expect(composerCommandQuery('please /ski')).toBeUndefined();
    expect(composerCommandQuery('/skill:playwright-cli now')).toBeUndefined();
    expect(composerCommandQuery('//nested')).toBeUndefined();
  });

  it('filters commands by case-insensitive prefix and keeps results bounded', () => {
    expect(composerCommandSuggestions(commands, '/RE')).toEqual([
      commands[2],
      commands[1],
    ]);
    expect(composerCommandSuggestions(commands, '/skill:')).toEqual([
      commands[0],
    ]);
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
