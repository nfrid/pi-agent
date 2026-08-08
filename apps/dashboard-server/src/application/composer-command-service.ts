import {
  DefaultResourceLoader,
  getAgentDir,
  type PromptTemplate,
  SettingsManager,
  type Skill,
} from '@earendil-works/pi-coding-agent';
import type {
  ComposerCommandCatalogue,
  ComposerCommandEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import {
  DASHBOARD_SUPPORTED_BUILTIN_COMMANDS,
  MAX_COMPOSER_COMMAND_ARGUMENT_HINT,
  MAX_COMPOSER_COMMAND_DESCRIPTION,
  MAX_COMPOSER_COMMAND_NAME,
  MAX_COMPOSER_COMMANDS,
} from '@pi-dashboard/protocol';

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = Array.from(value, (character) =>
    character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
      ? ''
      : character,
  )
    .join('')
    .trim()
    .slice(0, max);
  return text || undefined;
}

function commandEntry(value: {
  name?: unknown;
  description?: unknown;
  argumentHint?: unknown;
  source: ComposerCommandEntry['source'];
}): ComposerCommandEntry | undefined {
  let name = boundedText(value.name, MAX_COMPOSER_COMMAND_NAME);
  if (!name) return undefined;
  if (value.source === 'skill' && !name.startsWith('skill:'))
    name = `skill:${name}`;
  name = name.slice(0, MAX_COMPOSER_COMMAND_NAME);
  if (!name) return undefined;
  const description = boundedText(
    value.description,
    MAX_COMPOSER_COMMAND_DESCRIPTION,
  );
  const argumentHint = boundedText(
    value.argumentHint,
    MAX_COMPOSER_COMMAND_ARGUMENT_HINT,
  );
  return {
    name,
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    source: value.source,
  };
}

export function composerCommandCatalogue(
  prompts: readonly PromptTemplate[],
  skills: readonly Skill[],
): ComposerCommandCatalogue {
  const commands: ComposerCommandEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: ComposerCommandEntry | undefined) => {
    if (
      !entry ||
      seen.has(entry.name) ||
      commands.length >= MAX_COMPOSER_COMMANDS
    )
      return;
    seen.add(entry.name);
    commands.push(entry);
  };
  for (const builtin of DASHBOARD_SUPPORTED_BUILTIN_COMMANDS)
    add(commandEntry(builtin));
  for (const prompt of prompts)
    add(commandEntry({ ...prompt, source: 'prompt' }));
  for (const skill of skills)
    add(
      commandEntry({
        ...skill,
        name: skill.name.startsWith('skill:')
          ? skill.name
          : `skill:${skill.name}`,
        source: 'skill',
      }),
    );
  return { commands };
}

function unknownWorkspace(workspaceId: string): Error & { code: string } {
  return Object.assign(new Error(`Unknown workspace: ${workspaceId}`), {
    code: 'unknown-workspace',
  });
}

/** Discovers dashboard-safe prompt/skill commands without loading extensions. */
export class ComposerCommandService {
  constructor(private readonly agentDir = getAgentDir()) {}

  async forWorkspace(
    workspaceId: string,
    workspaces: readonly WorkspaceTarget[],
  ): Promise<ComposerCommandCatalogue> {
    const workspace = workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) throw unknownWorkspace(workspaceId);
    const cwd = workspace.canonicalPath;
    if (!cwd) throw unknownWorkspace(workspaceId);

    const settingsManager = SettingsManager.create(cwd, this.agentDir, {
      projectTrusted: true,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    return composerCommandCatalogue(
      resourceLoader.getPrompts().prompts,
      resourceLoader.getSkills().skills,
    );
  }
}
