import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  type BuildSystemPromptOptions,
  formatSkillsForPrompt as formatPiSkillsForPrompt,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import {
  type LoadedInstruction,
  loadGuidelines,
  loadInstruction,
} from '../shared/instructions';

export function loadAgentInstructions(): LoadedInstruction[] {
  const workingStyle = loadInstruction('instructions/agent/working-style.md');
  const interaction = loadInstruction('instructions/agent/interaction.md');
  const toolUse = loadInstruction('instructions/agent/tool-use.md');
  return [workingStyle, interaction, toolUse];
}

export function formatSkillsForPrompt(
  skills: NonNullable<BuildSystemPromptOptions['skills']>,
): string {
  return formatPiSkillsForPrompt(skills);
}

export function isIsolatedGitWorktree(cwd: string): boolean {
  return gitIdentity(cwd)?.isWorktree ?? false;
}

interface GitIdentity {
  root: string;
  commonDir: string;
  isWorktree: boolean;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function gitIdentity(cwd: string): GitIdentity | undefined {
  let current = resolve(cwd);
  while (true) {
    const dotGit = resolve(current, '.git');
    try {
      if (lstatSync(dotGit).isDirectory()) {
        return {
          root: current,
          commonDir: canonicalPath(dotGit),
          isWorktree: false,
        };
      }
      if (lstatSync(dotGit).isFile()) {
        const match = /^gitdir:\s*(.+)$/u.exec(
          readFileSync(dotGit, 'utf8').trim(),
        );
        if (!match?.[1]) return undefined;
        const gitDir = resolve(current, match[1]);
        if (basename(dirname(gitDir)) !== 'worktrees') return undefined;
        const commonDir = readFileSync(
          resolve(gitDir, 'commondir'),
          'utf8',
        ).trim();
        if (!commonDir) return undefined;
        return {
          root: current,
          commonDir: canonicalPath(resolve(gitDir, commonDir)),
          isWorktree: true,
        };
      }
    } catch {
      // Continue to an ancestor when this directory has no usable Git marker.
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isWithin(path: string, parent: string): boolean {
  const fromParent = relative(parent, path);
  return (
    fromParent === '' ||
    (!isAbsolute(fromParent) &&
      fromParent !== '..' &&
      !fromParent.startsWith(`..${sep}`))
  );
}

export function filterGlobalContextFiles(
  contextFiles: NonNullable<BuildSystemPromptOptions['contextFiles']>,
  cwd: string,
  agentDir = getAgentDir(),
): NonNullable<BuildSystemPromptOptions['contextFiles']> {
  const resolvedAgentDir = resolve(agentDir);
  const resolvedCwd = resolve(cwd);
  const cwdIsInsideAgentDir = isWithin(resolvedCwd, resolvedAgentDir);
  const cwdIdentity = gitIdentity(resolvedCwd);
  const agentIdentity = gitIdentity(resolvedAgentDir);

  if (
    cwdIdentity?.isWorktree &&
    agentIdentity &&
    !agentIdentity.isWorktree &&
    canonicalPath(cwdIdentity.commonDir) ===
      canonicalPath(agentIdentity.commonDir) &&
    canonicalPath(cwdIdentity.root) !== canonicalPath(agentIdentity.root)
  ) {
    const contextFileNames = new Set([
      'AGENTS.override.md',
      'AGENTS.md',
      'AGENTS.MD',
      'CLAUDE.md',
      'CLAUDE.MD',
    ]);
    const worktreeRoot = canonicalPath(cwdIdentity.root);
    const mainRoot = canonicalPath(agentIdentity.root);
    const worktreeContextDirectories = new Set<string>();
    const paths = contextFiles.map((file) => canonicalPath(file.path));
    for (const path of paths) {
      if (!contextFileNames.has(basename(path))) continue;
      const fromWorktree = relative(worktreeRoot, path);
      if (
        !isAbsolute(fromWorktree) &&
        fromWorktree !== '..' &&
        !fromWorktree.startsWith(`..${sep}`)
      ) {
        const directory = dirname(fromWorktree);
        worktreeContextDirectories.add(directory === '.' ? '' : directory);
      }
    }

    return contextFiles.filter((_file, index) => {
      const path = paths[index];
      if (!contextFileNames.has(basename(path))) return true;

      // A worktree can be nested below its main checkout, so classify it first.
      const fromWorktree = relative(worktreeRoot, path);
      if (
        !isAbsolute(fromWorktree) &&
        fromWorktree !== '..' &&
        !fromWorktree.startsWith(`..${sep}`)
      ) {
        return true;
      }

      const fromMain = relative(mainRoot, path);
      if (
        !isAbsolute(fromMain) &&
        fromMain !== '..' &&
        !fromMain.startsWith(`..${sep}`)
      ) {
        const directory = dirname(fromMain);
        if (
          worktreeContextDirectories.has(directory === '.' ? '' : directory)
        ) {
          return false;
        }
      }
      return true;
    });
  }

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
  instructions: readonly LoadedInstruction[],
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
  instructions: readonly LoadedInstruction[],
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
  }

  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) addGuidelines(normalized);
  }

  if (
    mode === undefined ||
    mode === 'tui' ||
    mode === 'rpc' ||
    process.env.PI_DELEGATE_CHILD === '1'
  ) {
    addGuidelines(loadGuidelines('extensions/activity-groups/instructions.md'));
  }

  if (mode && mode !== 'tui') {
    addGuidelines(
      `Pi is running in ${mode} mode; avoid assuming interactive terminal UI is available.`,
    );
  }

  if (process.env.PI_DELEGATE_CHILD !== '1' && isIsolatedGitWorktree(cwd)) {
    addGuidelines(
      'This main agent is running in an isolated Git worktree. When the task is fully finished and validated, ask the user whether to merge the finished branch into its parent branch, unless the user already stated an integration preference.',
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
