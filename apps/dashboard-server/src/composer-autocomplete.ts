import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
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
