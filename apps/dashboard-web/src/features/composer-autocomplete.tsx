import { useMemo } from 'react';

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

export function composerCommandSuggestions(
  commands: readonly ComposerCommandOption[],
  markdown: string,
): ComposerCommandOption[] {
  const query = composerCommandQuery(markdown)?.toLocaleLowerCase();
  if (query === undefined) return [];
  return commands
    .filter((command) => command.name.toLocaleLowerCase().startsWith(query))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.source.localeCompare(right.source),
    )
    .slice(0, MAX_VISIBLE_COMMANDS);
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
      className="composer-autocomplete"
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
          <span className="composer-autocomplete-command">
            <strong>/{command.name}</strong>
            {command.argumentHint && <code>{command.argumentHint}</code>}
          </span>
          <span className="composer-autocomplete-detail">
            <small>{commandSourceLabel(command.source)}</small>
            {command.description && <span>{command.description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
