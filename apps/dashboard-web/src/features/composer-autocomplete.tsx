import { useMemo } from 'react';
import styles from './composer-autocomplete.module.css';

export type ComposerCommandOption = {
  name: string;
  description?: string;
  argumentHint?: string;
  source: 'builtin' | 'prompt' | 'skill';
};

const MAX_VISIBLE_COMMANDS = 8;

export function composerCommandQuery(markdown: string): string | undefined {
  const match = markdown.match(/^\/([^\s/]*)$/u);
  return match?.[1];
}

function subsequenceScore(target: string, query: string): number | undefined {
  if (!query) return 0;
  if (target === query) return -1_000;
  if (target.startsWith(query)) return -800 + target.length - query.length;

  let queryIndex = 0;
  let firstMatch = -1;
  let previousMatch = -1;
  let gaps = 0;
  for (const [targetIndex, character] of [...target].entries()) {
    if (character !== query[queryIndex]) continue;
    if (firstMatch < 0) firstMatch = targetIndex;
    if (previousMatch >= 0) gaps += targetIndex - previousMatch - 1;
    previousMatch = targetIndex;
    queryIndex += 1;
    if (queryIndex === query.length)
      return firstMatch * 4 + gaps * 2 + (target.length - query.length) / 100;
  }
  return undefined;
}

export function fuzzyCommandScore(
  commandName: string,
  query: string,
): number | undefined {
  const name = commandName.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const unqualifiedName = name.includes(':') ? name.split(':').at(-1) : name;
  const fullScore = subsequenceScore(name, normalizedQuery);
  const unqualifiedScore = unqualifiedName
    ? subsequenceScore(unqualifiedName, normalizedQuery)
    : undefined;
  if (fullScore === undefined) return unqualifiedScore;
  if (unqualifiedScore === undefined) return fullScore;
  return Math.min(fullScore, unqualifiedScore);
}

export function composerCommandSuggestions(
  commands: readonly ComposerCommandOption[],
  markdown: string,
): ComposerCommandOption[] {
  const query = composerCommandQuery(markdown);
  if (query === undefined) return [];
  return commands
    .flatMap((command) => {
      const score = fuzzyCommandScore(command.name, query);
      return score === undefined ? [] : [{ command, score }];
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.command.name.localeCompare(right.command.name) ||
        left.command.source.localeCompare(right.command.source),
    )
    .slice(0, MAX_VISIBLE_COMMANDS)
    .map(({ command }) => command);
}

export function commandSourceLabel(
  source: ComposerCommandOption['source'],
): string {
  switch (source) {
    case 'builtin':
      return 'Command';
    case 'prompt':
      return 'Prompt';
    case 'skill':
      return 'Skill';
  }
}

export function ComposerAutocomplete({
  id,
  commands,
  markdown,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
}: {
  id: string;
  commands: readonly ComposerCommandOption[];
  markdown: string;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onSelect: (command: ComposerCommandOption) => void;
}) {
  const suggestions = useMemo(
    () => composerCommandSuggestions(commands, markdown),
    [commands, markdown],
  );
  const boundedIndex = suggestions.length
    ? Math.min(selectedIndex, suggestions.length - 1)
    : 0;

  if (!suggestions.length) return null;

  return (
    <div
      className={`composer-autocomplete ${styles.autocomplete}`}
      id={id}
      role="listbox"
      aria-label="Available commands"
      data-active-option={`${id}-option-${boundedIndex}`}
    >
      {suggestions.map((command, index) => (
        <button
          className={index === boundedIndex ? 'selected' : undefined}
          id={`${id}-option-${index}`}
          key={`${command.source}:${command.name}`}
          type="button"
          role="option"
          aria-selected={index === boundedIndex}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onSelectedIndexChange(index)}
          onClick={() => onSelect(command)}
        >
          <span className={`composer-autocomplete-command ${styles.command}`}>
            <strong>/{command.name}</strong>
            {command.argumentHint && <code>{command.argumentHint}</code>}
          </span>
          <span className={`composer-autocomplete-detail ${styles.detail}`}>
            <small>{commandSourceLabel(command.source)}</small>
            {command.description && <span>{command.description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
