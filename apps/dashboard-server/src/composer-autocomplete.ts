import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  type ComposerCommandCatalogue,
  type ComposerFileSuggestion,
  type ComposerFileSuggestions,
  DASHBOARD_SUPPORTED_BUILTIN_COMMANDS,
  MAX_COMPOSER_COMMANDS,
  MAX_COMPOSER_FILE_SUGGESTIONS,
} from '@pi-dashboard/protocol';

const FD_RESULT_LIMIT = 100;
const FD_OUTPUT_LIMIT = 256 * 1024;
const FD_TIMEOUT_MS = 2_000;

async function composerResourceLoader(
  cwd: string,
): Promise<DefaultResourceLoader> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    }),
    noExtensions: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}

function parseArgs(value: string): string[] {
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

function substituteArgs(content: string, args: readonly string[]): string {
  const all = args.join(' ');
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/gu,
    (_match, target, fallback, sliceStart, sliceLength, simple) => {
      if (target) {
        const value =
          target === '@' || target === 'ARGUMENTS'
            ? all
            : args[Number(target) - 1];
        return value || fallback;
      }
      if (sliceStart) {
        const start = Math.max(0, Number(sliceStart) - 1);
        return args
          .slice(start, sliceLength ? start + Number(sliceLength) : undefined)
          .join(' ');
      }
      if (simple === '@' || simple === 'ARGUMENTS') return all;
      return args[Number(simple) - 1] ?? '';
    },
  );
}

type ComposerSkill = ReturnType<
  DefaultResourceLoader['getSkills']
>['skills'][number];

async function skillBlock(skill: ComposerSkill): Promise<string> {
  const content = await readFile(skill.filePath, 'utf8');
  const body = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')
    .trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

function replaceSkillReferences(
  text: string,
  skills: ReadonlyMap<string, ComposerSkill>,
): { text: string; selected: ComposerSkill[] } {
  const selected: ComposerSkill[] = [];
  const seen = new Set<string>();
  let fenced: '`' | '~' | undefined;
  let inlineTicks = 0;
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
      let result = '';
      for (let index = 0; index < line.length; ) {
        if (line[index] === '`') {
          let end = index + 1;
          while (line[end] === '`') end += 1;
          const count = end - index;
          if (inlineTicks === 0) inlineTicks = count;
          else if (inlineTicks === count) inlineTicks = 0;
          result += line.slice(index, end);
          index = end;
          continue;
        }
        if (
          inlineTicks === 0 &&
          line[index] === '$' &&
          line[index - 1] !== '\\'
        ) {
          const candidate = line
            .slice(index + 1)
            .match(/^[a-z0-9]+(?:-[a-z0-9]+)*/u)?.[0];
          const skill = candidate ? skills.get(candidate) : undefined;
          if (candidate && skill) {
            if (!seen.has(candidate)) {
              seen.add(candidate);
              selected.push(skill);
            }
            result += candidate;
            index += candidate.length + 1;
            continue;
          }
        }
        if (
          inlineTicks === 0 &&
          line[index] === '\\' &&
          line[index + 1] === '$'
        ) {
          result += '$';
          index += 2;
          continue;
        }
        result += line[index];
        index += 1;
      }
      return result;
    })
    .join('\n');
  return { text: rewritten, selected };
}

async function expandInlineSkills(
  text: string,
  skills: readonly ComposerSkill[],
): Promise<string> {
  const expanded = replaceSkillReferences(
    text,
    new Map(skills.map((skill) => [skill.name, skill])),
  );
  if (expanded.selected.length === 0) return expanded.text;
  const blocks = await Promise.all(expanded.selected.map(skillBlock));
  return `${blocks.join('\n\n')}\n\n${expanded.text}`;
}

export async function expandComposerTitleInput(
  cwd: string,
  text: string,
): Promise<string> {
  const normalized = text.trim();
  const loader = await composerResourceLoader(cwd);
  const skills = loader.getSkills().skills;
  const match = normalized.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/u);
  if (!match) return expandInlineSkills(normalized, skills);
  const name = match[1];
  const args = match[2] ?? '';
  const prompt = loader
    .getPrompts()
    .prompts.find((candidate) => candidate.name === name);
  if (prompt)
    return expandInlineSkills(
      substituteArgs(prompt.content, parseArgs(args)).trim(),
      skills,
    );
  if (!name.startsWith('skill:')) return expandInlineSkills(normalized, skills);
  const skillName = name.slice('skill:'.length);
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill) return normalized;
  try {
    const block = await skillBlock(skill);
    return args.trim() ? `${block}\n\n${args.trim()}` : block;
  } catch {
    return normalized;
  }
}

function cleanText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  const cleaned = value?.replace(/\s+/gu, ' ').trim().slice(0, maxLength);
  return cleaned || undefined;
}

export async function composerCommandCatalogue(
  cwd: string,
): Promise<ComposerCommandCatalogue> {
  const loader = await composerResourceLoader(cwd);
  const commands: ComposerCommandCatalogue['commands'][number][] = [
    ...DASHBOARD_SUPPORTED_BUILTIN_COMMANDS,
  ];
  const seen = new Set(commands.map((command) => command.name));
  const add = (
    name: string,
    source: 'prompt' | 'skill',
    description?: string,
    argumentHint?: string,
  ) => {
    if (seen.has(name) || commands.length >= MAX_COMPOSER_COMMANDS) return;
    seen.add(name);
    const cleanDescription = cleanText(description, 1_024);
    const cleanArgumentHint = cleanText(argumentHint, 256);
    commands.push({
      name,
      source,
      ...(cleanDescription ? { description: cleanDescription } : {}),
      ...(cleanArgumentHint ? { argumentHint: cleanArgumentHint } : {}),
    });
  };
  for (const prompt of loader.getPrompts().prompts)
    add(prompt.name, 'prompt', prompt.description, prompt.argumentHint);
  for (const skill of loader.getSkills().skills)
    add(`skill:${skill.name}`, 'skill', skill.description);
  return { commands };
}

function displayPath(value: string): string {
  return value.split(path.sep).join('/');
}

function resolveDisplayDirectory(cwd: string, displayBase: string): string {
  if (displayBase === '~' || displayBase.startsWith('~/'))
    return path.join(homedir(), displayBase.slice(2));
  if (path.isAbsolute(displayBase)) return displayBase;
  return path.resolve(cwd, displayBase || '.');
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function scopedSuggestion(
  displayBase: string,
  name: string,
  directory: boolean,
): ComposerFileSuggestion {
  const joined = `${displayBase}${name}${directory ? '/' : ''}`;
  return {
    value: joined,
    label: `${name}${directory ? '/' : ''}`,
    directory,
  };
}

async function directDirectorySuggestions(
  cwd: string,
  query: string,
): Promise<ComposerFileSuggestion[] | undefined> {
  const slash = query.lastIndexOf('/');
  if (slash < 0) return undefined;
  const displayBase = query.slice(0, slash + 1);
  const fragment = query.slice(slash + 1).toLocaleLowerCase();
  const directory = resolveDisplayDirectory(cwd, displayBase);
  if (!(await isDirectory(directory))) return [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const suggestions = await Promise.all(
      entries
        .filter((entry) => entry.name.toLocaleLowerCase().startsWith(fragment))
        .slice(0, FD_RESULT_LIMIT)
        .map(async (entry) => {
          const entryDirectory =
            entry.isDirectory() ||
            (entry.isSymbolicLink() &&
              (await isDirectory(path.join(directory, entry.name))));
          return scopedSuggestion(displayBase, entry.name, entryDirectory);
        }),
    );
    return suggestions
      .sort(
        (left, right) =>
          Number(right.directory) - Number(left.directory) ||
          left.label.localeCompare(right.label),
      )
      .slice(0, MAX_COMPOSER_FILE_SUGGESTIONS);
  } catch {
    return [];
  }
}

type FdEntry = { path: string; directory: boolean };

async function fdEntries(
  cwd: string,
  query: string,
): Promise<FdEntry[] | undefined> {
  const args = [
    '--base-directory',
    '.',
    '--max-results',
    String(FD_RESULT_LIMIT),
    '--type',
    'f',
    '--type',
    'd',
    '--follow',
    '--hidden',
    '--exclude',
    '.git',
    '--exclude',
    '.git/*',
    '--exclude',
    '.git/**',
  ];
  try {
    if ((await stat(path.join(cwd, '.gitignore'))).isFile())
      args.push('--ignore-file', '.gitignore');
  } catch {
    // Non-Git directories do not need an explicit root ignore file.
  }
  if (query) args.push('--fixed-strings', '--', query);
  return await new Promise((resolve) => {
    const child = spawn('fd', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (entries: FdEntry[] | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(entries);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, FD_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (output.length >= FD_OUTPUT_LIMIT) return;
      output += chunk.slice(0, FD_OUTPUT_LIMIT - output.length);
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => {
      if (code === 1 || (code === 0 && !output)) return finish([]);
      if (code !== 0) return finish(undefined);
      finish(
        output
          .split('\n')
          .filter(Boolean)
          .map((entry) => ({
            path: displayPath(entry),
            directory: entry.endsWith('/') || entry.endsWith(path.sep),
          })),
      );
    });
  });
}

function fileScore(entry: FdEntry, query: string): number {
  if (!query) return entry.directory ? 2 : 1;
  const filename = path
    .basename(entry.path.replace(/\/$/u, ''))
    .toLocaleLowerCase();
  const normalized = query.toLocaleLowerCase();
  if (filename === normalized) return 100;
  if (filename.startsWith(normalized)) return 80;
  if (filename.includes(normalized)) return 50;
  if (entry.path.toLocaleLowerCase().includes(normalized)) return 30;
  return 0;
}

export async function composerFileSuggestions(
  cwd: string,
  query: string,
): Promise<ComposerFileSuggestions> {
  const direct = await directDirectorySuggestions(cwd, query);
  if (direct !== undefined) return { suggestions: direct };
  let entries = await fdEntries(cwd, query);
  if (entries === undefined) {
    try {
      entries = (await readdir(cwd, { withFileTypes: true })).map((entry) => ({
        path: entry.name,
        directory: entry.isDirectory(),
      }));
    } catch {
      return { suggestions: [] };
    }
  }
  const suggestions = entries
    .map((entry) => ({ entry, score: fileScore(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.path.localeCompare(right.entry.path),
    )
    .slice(0, MAX_COMPOSER_FILE_SUGGESTIONS)
    .map(({ entry }) => {
      const value = `${entry.path.replace(/\/$/u, '')}${entry.directory ? '/' : ''}`;
      return {
        value,
        label: `${path.basename(value.replace(/\/$/u, ''))}${entry.directory ? '/' : ''}`,
        directory: entry.directory,
      };
    });
  return { suggestions };
}
