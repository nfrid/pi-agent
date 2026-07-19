import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  type BuildSystemPromptOptions,
  formatSkillsForPrompt as formatPiSkillsForPrompt,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

const GUIDELINES = {
  KISS: 'Prefer the simplest design that solves the problem. Add structure only when it clearly pays for itself now.',
  concise:
    'Be concise and direct. Lead with the answer. Skip restating the request and filler; add detail only when it improves correctness.',

  bash: [
    'Combine related bash discovery into one pipeline; run unrelated checks in parallel.',
    'Keep bash output bounded with targeted paths, filters, counts, excerpts, diffs, or short summaries.',
    'Use separate calls when results need judgment, and before writes or destructive work; prefer read, edit, and write tools for file contents.',
  ],
};

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
): string {
  let finalized = appendProjectContext(prompt, contextFiles);
  if (includeSkills) finalized += formatSkillsForPrompt(skills);
  finalized += `\nCurrent date: ${currentDate()}`;
  finalized += `\nCurrent working directory: ${cwd.replace(/\\/g, '/')}`;
  return finalized;
}

function enhanceToolSnippet(name: string, snippet: string): string {
  if (name !== 'bash') {
    return snippet;
  }

  return `${snippet} Prefer readable pipelines or short scripts for multi-step work; keep stdout focused because it enters model context.`;
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
  const tools = selectedTools || ['read', 'bash', 'edit', 'write'];
  const hasBash = tools.includes('bash');
  const hasRead = tools.includes('read');

  const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools
          .map((name) => {
            const snippet = toolSnippets?.[name];
            return `- ${name}: ${enhanceToolSnippet(name, snippet ?? '')}`;
          })
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
      addGuidelines('Use bash for file operations like ls, rg, find');
    }
    addGuidelines(GUIDELINES.bash);
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

  addGuidelines(GUIDELINES.KISS);
  addGuidelines(GUIDELINES.concise);
  addGuidelines('Show file paths clearly when working with files');
  const guidelines = guidelinesList
    .map((guideline) => `- ${guideline}`)
    .join('\n');

  const role =
    'You are a coding agent in pi. Help by reading files, running commands, and editing code.';

  const prompt = `${role}

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}`;

  return finalizePrompt(prompt, contextFiles, skills, hasRead, cwd);
}
