import type { BuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';
import { formatDelegateRoutingPrompt } from './routing';

export function formatSkillsForPrompt(
  skills: NonNullable<BuildSystemPromptOptions['skills']>,
): string {
  if (skills.length === 0) {
    return '';
  }

  const skillEntries = skills
    .filter((skill) => !skill.disableModelInvocation)
    .map(
      (skill) =>
        `  <skill name="${escapeXml(skill.name)}" path="${escapeXml(skill.filePath)}">\n    ${escapeXml(skill.description)}\n  </skill>`,
    )
    .join('\n');

  if (skillEntries.length === 0) {
    return '';
  }

  return `\n\n<available_skills>\n${skillEntries}\n</available_skills>`;
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

const BASH_GUIDELINES = [
  'Prefer one composed bash call for dependent deterministic discovery, filtering, aggregation, or validation; run unrelated inspections in parallel.',
  'Keep bash output bounded and relevant using targeted paths, filters, counts, excerpts, diffs, or compact structured summaries.',
  'Use separate calls when results require semantic judgment, and before writes, destructive actions, or scope-expanding work; prefer dedicated read, edit, and write tools for file contents.',
];

function enhanceToolSnippet(name: string, snippet: string): string {
  if (name !== 'bash') {
    return snippet;
  }

  return `${snippet} Prefer readable composed pipelines or temporary scripts for deterministic multi-step work, and keep stdout focused because it is added to model context.`;
}

function formatBashGuidance(): string {
  return `\n\nBash guidance:\n${BASH_GUIDELINES.map((guideline) => `- ${guideline}`).join('\n')}`;
}

export function buildSystemPrompt(
  options: BuildSystemPromptOptions,
  mode?: string,
  isDelegateChild = process.env.PI_DELEGATE_CHILD === '1',
): string {
  const {
    customPrompt,
    selectedTools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    contextFiles: providedContextFiles,
    skills: providedSkills,
  } = options;
  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : '';
  const contextFiles = providedContextFiles ?? [];
  const skills = providedSkills ?? [];
  const tools = selectedTools || ['read', 'bash', 'edit', 'write'];
  const hasBash = tools.includes('bash');
  const hasRead = tools.includes('read');
  const delegateRoutingSection =
    !isDelegateChild && tools.includes('delegate')
      ? formatDelegateRoutingPrompt(cwd)
      : '';

  if (customPrompt) {
    let prompt = customPrompt;
    if (isDelegateChild) {
      prompt +=
        '\n\nDelegated child context:\n- You are a focused subagent reporting to a parent agent. Complete only the delegated task and prioritize decision-useful findings over broad exploration.\n- Work autonomously without asking the user questions; when the task is ambiguous, make the safest reasonable assumption and state it in your result.';
    }
    if (appendSection) {
      prompt += appendSection;
    }
    if (hasBash) {
      prompt += formatBashGuidance();
    }
    prompt += delegateRoutingSection;
    return finalizePrompt(prompt, contextFiles, skills, hasRead, cwd);
  }

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
  const addGuideline = (guideline: string) => {
    if (guidelinesSet.has(guideline)) {
      return;
    }
    guidelinesSet.add(guideline);
    guidelinesList.push(guideline);
  };

  const hasGrep = tools.includes('grep');
  const hasFind = tools.includes('find');
  const hasLs = tools.includes('ls');

  if (hasBash) {
    if (!hasGrep && !hasFind && !hasLs) {
      addGuideline('Use bash for file operations like ls, rg, find');
    }
    for (const guideline of BASH_GUIDELINES) {
      addGuideline(guideline);
    }
  }

  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) {
      addGuideline(normalized);
    }
  }

  if (mode && mode !== 'tui') {
    addGuideline(
      `Pi is running in ${mode} mode; avoid assuming interactive terminal UI is available.`,
    );
  }

  if (isDelegateChild) {
    addGuideline(
      'You are a focused subagent reporting to a parent agent. Complete only the delegated task and prioritize decision-useful findings over broad exploration.',
    );
    addGuideline(
      'Work autonomously without asking the user questions; when the task is ambiguous, make the safest reasonable assumption and state it in your result.',
    );
  }
  addGuideline(
    'Be concise, direct, and pragmatic. Lead with the answer or result. Skip restating the request, generic explanations, and filler. Add detail only when it materially improves correctness or usefulness.',
  );
  addGuideline('Show file paths clearly when working with files');
  const guidelines = guidelinesList
    .map((guideline) => `- ${guideline}`)
    .join('\n');

  const role = isDelegateChild
    ? 'You are a focused coding subagent operating inside pi, a coding agent harness. You complete a delegated task autonomously and return the result to a parent agent.'
    : 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';

  let prompt = `${role}

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}`;

  if (appendSection) {
    prompt += appendSection;
  }
  prompt += delegateRoutingSection;

  return finalizePrompt(prompt, contextFiles, skills, hasRead, cwd);
}
