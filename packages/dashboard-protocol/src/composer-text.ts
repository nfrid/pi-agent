/** Pure prompt argument and inline-skill syntax shared by titles and execution. */
export function parsePromptArguments(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/u.test(character)) {
      if (current) args.push(current);
      current = '';
    } else current += character;
  }
  if (current) args.push(current);
  return args;
}

function isAllArguments(target: string): boolean {
  return target === '@' || target === 'ARGUMENTS';
}

export function substitutePromptArguments(
  content: string,
  args: readonly string[],
): string {
  const all = args.join(' ');
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/gu,
    (_match, target, fallback, sliceStart, sliceLength, simple) => {
      if (target) {
        const value = isAllArguments(target) ? all : args[Number(target) - 1];
        return value || fallback;
      }
      if (sliceStart) {
        const start = Math.max(0, Number(sliceStart) - 1);
        return args
          .slice(start, sliceLength ? start + Number(sliceLength) : undefined)
          .join(' ');
      }
      if (isAllArguments(simple)) return all;
      return args[Number(simple) - 1] ?? '';
    },
  );
}

function replaceUnquotedSkills<T extends object>(
  text: string,
  skills: ReadonlyMap<string, T>,
  select: (name: string, skill: T) => void,
): string {
  return text.replace(
    /\\\$|\$([a-z0-9]+(?:-[a-z0-9]+)*)/gu,
    (match, name: string) => {
      if (match === '\\$') return '$';
      const skill = skills.get(name);
      if (!skill) return match;
      select(name, skill);
      return name;
    },
  );
}

/** Backtick runs delimit inline code, including spans across lines. */
function replaceOutsideInlineCode(
  line: string,
  state: { ticks: number },
  replace: (text: string) => string,
): string {
  return line
    .split(/(`+)/u)
    .map((part, index) => {
      if (index % 2 === 1) {
        if (state.ticks === 0) state.ticks = part.length;
        else if (state.ticks === part.length) state.ticks = 0;
        return part;
      }
      return state.ticks === 0 ? replace(part) : part;
    })
    .join('');
}

export function replaceSkillReferences<T extends object>(
  text: string,
  skills: ReadonlyMap<string, T>,
): { text: string; selected: T[] } {
  const selected: T[] = [];
  const seen = new Set<string>();
  const select = (name: string, skill: T) => {
    if (seen.has(name)) return;
    seen.add(name);
    selected.push(skill);
  };
  let fenced: '`' | '~' | undefined;
  const inline = { ticks: 0 };
  const rewritten = text
    .split('\n')
    .map((line) => {
      const fence = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
      if (fence) {
        const marker = fence[0] as '`' | '~';
        if (!fenced) fenced = marker;
        else if (fenced === marker) fenced = undefined;
        return line;
      }
      if (fenced) return line;
      return replaceOutsideInlineCode(line, inline, (plain) =>
        replaceUnquotedSkills(plain, skills, select),
      );
    })
    .join('\n');
  return { text: rewritten, selected };
}
