import type {
  ComposerCommandEntry,
  ComposerFileSuggestion,
} from '@pi-dashboard/protocol';
import styles from './composer-autocomplete.module.css';

export type ComposerCommandOption = ComposerCommandEntry;
export type ComposerCompletionKind = 'command' | 'file' | 'skill';

export type ComposerCompletionToken = {
  kind: ComposerCompletionKind;
  prefix: string;
  query: string;
  start: number;
  end: number;
};

export type ComposerSuggestion = {
  kind: ComposerCompletionKind;
  value: string;
  label: string;
  detail?: string;
  description?: string;
  source?: ComposerCommandOption['source'];
  directory?: boolean;
  matches: readonly number[];
};

const MAX_VISIBLE_SUGGESTIONS = 8;

export function composerCompletionToken(
  text: string,
  cursor: number,
): ComposerCompletionToken | undefined {
  const before = text.slice(0, cursor);
  const slash = before.match(/^\/([^\s/]*)$/u);
  if (slash)
    return {
      kind: 'command',
      prefix: slash[0],
      query: slash[1] ?? '',
      start: 0,
      end: cursor,
    };
  const natural = before.match(/(?:^|[\s([{])([@$])([^\s@$]*)$/u);
  if (!natural || natural.index === undefined) return undefined;
  const sigil = natural[1];
  const query = natural[2] ?? '';
  const start = natural.index + natural[0].length - query.length - 1;
  return {
    kind: sigil === '@' ? 'file' : 'skill',
    prefix: `${sigil}${query}`,
    query,
    start,
    end: cursor,
  };
}

function subsequenceMatch(
  target: string,
  query: string,
): { score: number; matches: number[] } | undefined {
  if (!query) return { score: 0, matches: [] };
  const normalizedTarget = target.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  if (normalizedTarget === normalizedQuery)
    return {
      score: -1_000,
      matches: Array.from({ length: target.length }, (_, index) => index),
    };
  let queryIndex = 0;
  let firstMatch = -1;
  let previousMatch = -1;
  let gaps = 0;
  const matches: number[] = [];
  for (const [targetIndex, character] of [...normalizedTarget].entries()) {
    if (character !== normalizedQuery[queryIndex]) continue;
    if (firstMatch < 0) firstMatch = targetIndex;
    if (previousMatch >= 0) gaps += targetIndex - previousMatch - 1;
    previousMatch = targetIndex;
    matches.push(targetIndex);
    queryIndex += 1;
    if (queryIndex === normalizedQuery.length) {
      const prefixBonus = firstMatch === 0 ? -800 : 0;
      return {
        score:
          prefixBonus +
          firstMatch * 4 +
          gaps * 2 +
          (target.length - query.length) / 100,
        matches,
      };
    }
  }
  return undefined;
}

export function fuzzyCommandScore(
  commandName: string,
  query: string,
): number | undefined {
  const unqualifiedName = commandName.includes(':')
    ? commandName.split(':').at(-1)
    : commandName;
  const full = subsequenceMatch(commandName, query)?.score;
  const unqualified = unqualifiedName
    ? subsequenceMatch(unqualifiedName, query)?.score
    : undefined;
  if (full === undefined) return unqualified;
  if (unqualified === undefined) return full;
  return Math.min(full, unqualified);
}

function commandSuggestion(
  command: ComposerCommandOption,
  token: ComposerCompletionToken,
): { suggestion: ComposerSuggestion; score: number } | undefined {
  if (token.kind === 'file') return undefined;
  if (token.kind === 'skill' && command.source !== 'skill') return undefined;
  if (token.kind === 'command' && command.source === 'skill') return undefined;
  const name =
    command.source === 'skill' && command.name.startsWith('skill:')
      ? command.name.slice(6)
      : command.name;
  const match = subsequenceMatch(name, token.query);
  if (!match) return undefined;
  const sigil = token.kind === 'skill' ? '$' : '/';
  return {
    score: match.score,
    suggestion: {
      kind: token.kind,
      value: `${sigil}${name}`,
      label: `${sigil}${name}`,
      description: command.description,
      source: command.source,
      matches: match.matches.map((index) => index + 1),
      ...(command.argumentHint ? { detail: command.argumentHint } : {}),
    },
  };
}

export function composerCommandSuggestions(
  commands: readonly ComposerCommandOption[],
  token: ComposerCompletionToken | undefined,
): ComposerSuggestion[] {
  if (!token || token.kind === 'file') return [];
  return commands
    .flatMap((command) => {
      const result = commandSuggestion(command, token);
      return result ? [result] : [];
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.suggestion.label.localeCompare(right.suggestion.label),
    )
    .slice(0, MAX_VISIBLE_SUGGESTIONS)
    .map(({ suggestion }) => suggestion);
}

export function composerFileSuggestionOptions(
  files: readonly ComposerFileSuggestion[],
  token: ComposerCompletionToken | undefined,
): ComposerSuggestion[] {
  if (token?.kind !== 'file') return [];
  return files.slice(0, MAX_VISIBLE_SUGGESTIONS).map((file) => {
    const matchTarget = file.value;
    const match = subsequenceMatch(matchTarget, token.query);
    return {
      kind: 'file',
      value: `@${file.value}`,
      label: `@${file.value}`,
      detail: file.detail,
      directory: file.directory,
      matches: (match?.matches ?? []).map((index) => index + 1),
    };
  });
}

export function commandSourceLabel(
  source: ComposerCommandOption['source'] | undefined,
  kind: ComposerCompletionKind,
): string {
  if (kind === 'file') return 'File';
  if (kind === 'skill') return 'Skill';
  return source === 'prompt' ? 'Prompt' : 'Command';
}

function HighlightedLabel({ suggestion }: { suggestion: ComposerSuggestion }) {
  const matches = new Set(suggestion.matches);
  return (
    <strong>
      {[...suggestion.label].map((character, index) =>
        matches.has(index) ? (
          <mark key={suggestion.label.slice(0, index + 1)}>{character}</mark>
        ) : (
          character
        ),
      )}
    </strong>
  );
}

export function ComposerAutocomplete({
  id,
  suggestions,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
}: {
  id: string;
  suggestions: readonly ComposerSuggestion[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onSelect: (suggestion: ComposerSuggestion) => void;
}) {
  const boundedIndex = suggestions.length
    ? Math.min(selectedIndex, suggestions.length - 1)
    : 0;
  if (!suggestions.length) return null;
  return (
    <div
      className={`composer-autocomplete ${styles.autocomplete}`}
      id={id}
      role="listbox"
      aria-label="Autocomplete suggestions"
      data-active-option={`${id}-option-${boundedIndex}`}
    >
      {suggestions.map((suggestion, index) => (
        <button
          className={index === boundedIndex ? 'selected' : undefined}
          id={`${id}-option-${index}`}
          key={`${suggestion.kind}:${suggestion.value}`}
          type="button"
          role="option"
          aria-selected={index === boundedIndex}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onSelectedIndexChange(index)}
          onClick={() => onSelect(suggestion)}
        >
          <span className={`composer-autocomplete-command ${styles.command}`}>
            <HighlightedLabel suggestion={suggestion} />
            {suggestion.detail && <code>{suggestion.detail}</code>}
          </span>
          <span className={`composer-autocomplete-detail ${styles.detail}`}>
            <small>
              {commandSourceLabel(suggestion.source, suggestion.kind)}
            </small>
            {suggestion.description && <span>{suggestion.description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
