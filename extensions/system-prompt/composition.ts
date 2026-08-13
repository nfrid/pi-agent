import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  type BuildSystemPromptOptions,
  formatSkillsForPrompt as formatPiSkillsForPrompt,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import {
  type LoadedAgentInstruction,
  loadAgentInstruction,
} from '../shared/agent-instructions';

const BASH_GUIDELINES = [
  'Combine related bash discovery into one pipeline; run unrelated checks in parallel.',
  'Keep bash output bounded with targeted paths, filters, counts, excerpts, diffs, or short summaries.',
  'Use separate calls when results need judgment, and before writes or destructive work; prefer read, edit, and write tools for file contents.',
];

export function loadAgentInstructions(): LoadedAgentInstruction[] {
  const workingStyle = loadAgentInstruction(
    'instructions/agent/working-style.md',
  );
  const interaction = loadAgentInstruction('instructions/agent/interaction.md');
  return [workingStyle, interaction];
}

export function formatSkillsForPrompt(
  skills: NonNullable<BuildSystemPromptOptions['skills']>,
): string {
  return formatPiSkillsForPrompt(skills);
}

export function filterGlobalContextFiles(
  contextFiles: NonNullable<BuildSystemPromptOptions['contextFiles']>,
  cwd: string,
  agentDir = getAgentDir(),
): NonNullable<BuildSystemPromptOptions['contextFiles']> {
  const resolvedAgentDir = resolve(agentDir);
  const fromAgentDir = relative(resolvedAgentDir, resolve(cwd));
  const cwdIsInsideAgentDir =
    fromAgentDir === '' ||
    (!isAbsolute(fromAgentDir) &&
      fromAgentDir !== '..' &&
      !fromAgentDir.startsWith(
        `..${process.platform === 'win32' ? '\\' : '/'}`,
      ));
  if (cwdIsInsideAgentDir) return contextFiles;

  return contextFiles.filter(
    (file) => dirname(resolve(file.path)) !== resolvedAgentDir,
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function currentDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function appendAgentInstructions(
  prompt: string,
  instructions: readonly LoadedAgentInstruction[],
): string {
  const content = instructions
    .map((instruction) => instruction.content)
    .join('\n\n');
  return `${prompt}\n\n<agent_instructions>\n${content}\n</agent_instructions>\n`;
}

function appendProjectContext(
  prompt: string,
  contextFiles: NonNullable<BuildSystemPromptOptions['contextFiles']>,
): string {
  if (contextFiles.length === 0) {
    return prompt;
  }

  let nextPrompt = `${prompt}\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n`;
  for (const { path, content } of contextFiles) {
    nextPrompt += `<project_instructions path="${escapeXml(path)}">\n${content}\n</project_instructions>\n\n`;
  }
  nextPrompt += '</project_context>\n';
  return nextPrompt;
}

function finalizePrompt(
  prompt: string,
  contextFiles: NonNullable<BuildSystemPromptOptions['contextFiles']>,
  skills: NonNullable<BuildSystemPromptOptions['skills']>,
  includeSkills: boolean,
  cwd: string,
  instructions: readonly LoadedAgentInstruction[],
): string {
  let finalized = appendAgentInstructions(prompt, instructions);
  finalized = appendProjectContext(finalized, contextFiles);
  if (includeSkills) finalized += formatSkillsForPrompt(skills);
  finalized += `\nCurrent date: ${currentDate()}`;
  finalized += `\nCurrent working directory: ${cwd.replace(/\\/g, '/')}`;
  return finalized;
}

export function buildSystemPrompt(
  options: BuildSystemPromptOptions,
  mode?: string,
): string {
  const {
    selectedTools,
    toolSnippets,
    promptGuidelines,
    cwd,
    contextFiles: providedContextFiles,
    skills: providedSkills,
  } = options;
  const contextFiles = filterGlobalContextFiles(
    providedContextFiles ?? [],
    cwd,
  );
  const skills = providedSkills ?? [];
  const instructions = loadAgentInstructions();
  const tools = selectedTools || ['read', 'bash', 'edit', 'write'];
  const hasBash = tools.includes('bash');
  const hasRead = tools.includes('read');

  const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools
          .map((name) => `- ${name}: ${toolSnippets?.[name] ?? ''}`)
          .join('\n')
      : '(none)';

  const guidelinesList: string[] = [];
  const guidelinesSet = new Set<string>();
  const addGuidelines = (guidelines: string | string[]) => {
    if (Array.isArray(guidelines)) {
      guidelines.forEach((g) => {
        addGuidelines(g);
      });
      return;
    }
    if (guidelinesSet.has(guidelines)) {
      return;
    }
    guidelinesSet.add(guidelines);
    guidelinesList.push(guidelines);
  };

  const hasGrep = tools.includes('grep');
  const hasFind = tools.includes('find');
  const hasLs = tools.includes('ls');

  if (hasBash) {
    if (!hasGrep && !hasFind && !hasLs) {
      addGuidelines('Use bash for listing and searching files (ls, rg, find)');
    }
    addGuidelines(BASH_GUIDELINES);
  }

  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) addGuidelines(normalized);
  }

  if (mode && mode !== 'tui') {
    addGuidelines(
      `Pi is running in ${mode} mode; avoid assuming interactive terminal UI is available.`,
    );
  }

  const guidelines = guidelinesList
    .map((guideline) => `- ${guideline}`)
    .join('\n');

  const role =
    'You are a coding agent in pi. You read files, run commands, and edit code to carry a task through to a verified result.';

  const prompt = `${role}

Available tools:
${toolsList}

Guidelines:
${guidelines}`;

  return finalizePrompt(
    prompt,
    contextFiles,
    skills,
    hasRead,
    cwd,
    instructions,
  );
}
