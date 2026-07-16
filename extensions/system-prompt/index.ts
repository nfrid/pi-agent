import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

const PI_DIAGNOSTICS_LIMITATION =
  'Pi 0.80.7 exposes loaded skill winners only. Duplicate definitions below are an advisory filesystem scan, not active collision diagnostics; extensions cannot control /skill resolution or add qualified /skill selection.';

function formatSkillsForPrompt(
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

export interface SizeEstimate {
  characters: number;
  tokens: number;
}

export interface ContextDiagnostics {
  calls: number;
  messages: number;
  retainedToolResults: SizeEstimate & { count: number };
  todoReplay: SizeEstimate & { count: number; hash?: string };
}

export interface UsageDiagnostics {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  peakContext: number;
}

export interface SkillDefinition {
  name: string;
  filePath: string;
  skillDir: string;
}

export function estimateSize(value: string): SizeEstimate {
  return { characters: value.length, tokens: Math.ceil(value.length / 4) };
}

function textCharacters(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce(
    (total, part) =>
      total +
      (typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text.length
        : 0),
    0,
  );
}

export function summarizeContextMessages(
  messages: ReadonlyArray<{
    role: string;
    content?: unknown;
    toolName?: string;
    customType?: string;
  }>,
  calls = 1,
): ContextDiagnostics {
  let toolCount = 0;
  let toolCharacters = 0;
  let replayCount = 0;
  let replayCharacters = 0;
  let replayContent = '';
  for (const message of messages) {
    if (message.role === 'toolResult') {
      toolCount++;
      toolCharacters += textCharacters(message.content);
    }
    if (
      message.role === 'custom' &&
      (message.customType === 'lean-todo-replay' ||
        message.customType === 'lean-todo-replay-v2')
    ) {
      replayCount++;
      replayCharacters += textCharacters(message.content);
      if (typeof message.content === 'string') replayContent += message.content;
    }
  }
  return {
    calls,
    messages: messages.length,
    retainedToolResults: {
      count: toolCount,
      ...estimateSize('x'.repeat(toolCharacters)),
    },
    todoReplay: {
      count: replayCount,
      ...estimateSize('x'.repeat(replayCharacters)),
      hash:
        replayCount > 0
          ? createHash('sha256')
              .update(replayContent)
              .digest('hex')
              .slice(0, 12)
          : undefined,
    },
  };
}

export function aggregateAssistantUsage(
  messages: ReadonlyArray<{ role: string; usage?: AssistantMessage['usage'] }>,
): UsageDiagnostics {
  const result: UsageDiagnostics = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    peakContext: 0,
  };
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.usage) continue;
    result.turns++;
    result.input += message.usage.input ?? 0;
    result.output += message.usage.output ?? 0;
    result.cacheRead += message.usage.cacheRead ?? 0;
    result.cacheWrite += message.usage.cacheWrite ?? 0;
    result.peakContext = Math.max(
      result.peakContext,
      message.usage.totalTokens ?? 0,
    );
  }
  return result;
}

function parseSkillName(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf8');
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
    const configured = frontmatter
      ?.split(/\r?\n/)
      .find((line) => /^name\s*:/.test(line))
      ?.replace(/^name\s*:\s*/, '')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    return configured || dirname(filePath).split(/[\\/]/).pop() || filePath;
  } catch {
    return dirname(filePath).split(/[\\/]/).pop() || filePath;
  }
}

function collectSkillFiles(dir: string, includeRootFiles = true): string[] {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      return [join(dir, 'SKILL.md')];
    }
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) result.push(...collectSkillFiles(path, false));
      else if (includeRootFiles && entry.isFile() && entry.name.endsWith('.md'))
        result.push(path);
      else if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(path);
          if (stats.isDirectory())
            result.push(...collectSkillFiles(path, false));
          else if (includeRootFiles && stats.isFile() && path.endsWith('.md'))
            result.push(path);
        } catch {}
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function discoverAncestorSkillDefinitions(
  cwd: string,
): SkillDefinition[] {
  const start = resolve(cwd);
  let gitRoot: string | undefined;
  let cursor = start;
  while (true) {
    if (existsSync(join(cursor, '.git'))) {
      gitRoot = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const definitions: SkillDefinition[] = [];
  cursor = start;
  while (true) {
    const skillDir = join(cursor, '.agents', 'skills');
    for (const filePath of collectSkillFiles(skillDir)) {
      definitions.push({
        name: parseSkillName(filePath),
        filePath,
        skillDir,
      });
    }
    if (cursor === gitRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return definitions;
}

export function todoStateVersion(
  entries: ReadonlyArray<{
    type: string;
    customType?: string;
    data?: unknown;
  }>,
): number | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== 'custom' || entry.customType !== 'lean-todo') continue;
    const data = entry.data;
    if (typeof data !== 'object' || data === null || !('state' in data))
      continue;
    const state = data.state;
    if (
      typeof state === 'object' &&
      state !== null &&
      'version' in state &&
      typeof state.version === 'number'
    )
      return state.version;
  }
}

function sizeLine(label: string, size: SizeEstimate): string {
  return `${label}: ${size.characters} chars (~${size.tokens} tokens)`;
}

export function formatPromptInfo(
  options: BuildSystemPromptOptions,
  effectivePrompt: string,
  context: ContextDiagnostics,
  usage: UsageDiagnostics,
  definitions: readonly SkillDefinition[],
  replayVersion?: number,
): string {
  const contextFiles = options.contextFiles ?? [];
  const allSkills = options.skills ?? [];
  const skills = allSkills.filter((skill) => !skill.disableModelInvocation);
  const tools = options.selectedTools ?? ['read', 'bash', 'edit', 'write'];
  const basePrompt = buildSystemPrompt({
    ...options,
    contextFiles: [],
    skills: [],
  });
  const contextOnlyPrompt = buildSystemPrompt({
    ...options,
    contextFiles,
    skills: [],
  });
  const skillIndex = tools.includes('read')
    ? formatSkillsForPrompt(skills)
    : '';
  const snippetCharacters = tools.reduce(
    (total, tool) => total + (options.toolSnippets?.[tool]?.length ?? 0),
    0,
  );
  const duplicateGroups = new Map<string, SkillDefinition[]>();
  for (const definition of definitions) {
    const group = duplicateGroups.get(definition.name) ?? [];
    group.push(definition);
    duplicateGroups.set(definition.name, group);
  }
  const duplicates = [...duplicateGroups.entries()].filter(
    ([, group]) =>
      new Set(group.map((item) => resolve(item.filePath))).size > 1,
  );

  return [
    `CWD: ${options.cwd}`,
    'Token estimates use the aggregate heuristic of 4 characters/token.',
    sizeLine('Effective system prompt', estimateSize(effectivePrompt)),
    sizeLine('Rebuilt system prompt', estimateSize(buildSystemPrompt(options))),
    sizeLine(
      'Base prompt (without context files/skills)',
      estimateSize(basePrompt),
    ),
    sizeLine(
      'Context-file rendered contribution',
      estimateSize(
        'x'.repeat(Math.max(0, contextOnlyPrompt.length - basePrompt.length)),
      ),
    ),
    `Context files: ${contextFiles.length}`,
    ...contextFiles.map(
      (file) =>
        `- ${file.path}: ${sizeLine('', estimateSize(file.content)).slice(2)}`,
    ),
    sizeLine('Visible skill-index contribution', estimateSize(skillIndex)),
    `Loaded skill winners: ${allSkills.length} (${skills.length} model-visible, ${allSkills.length - skills.length} explicit-only)`,
    ...allSkills.map(
      (skill) =>
        `- ${skill.name}: ${skill.filePath} [source=${skill.sourceInfo.source}, scope=${skill.sourceInfo.scope}${skill.disableModelInvocation ? ', model-invocation=disabled' : ''}]`,
    ),
    `Active tools: ${tools.join(', ') || '(none)'}`,
    sizeLine(
      'Visible tool prompt snippets',
      estimateSize('x'.repeat(snippetCharacters)),
    ),
    ...tools.map((tool) => {
      const snippet = options.toolSnippets?.[tool];
      return `- ${tool}: ${snippet === undefined ? 'no prompt snippet exposed' : `${snippet.length} snippet chars`}`;
    }),
    'Tool parameter schemas: unavailable (Pi 0.80.7 does not expose active schemas through the typed extension API).',
    `Latest context observation at this extension hook (later context transforms, if any, are not included): ${context.calls} call(s), ${context.messages} messages`,
    sizeLine(
      `Retained tool results (${context.retainedToolResults.count})`,
      context.retainedToolResults,
    ),
    sizeLine(`Todo replay (${context.todoReplay.count})`, context.todoReplay),
    `Todo replay hash: ${context.todoReplay.hash ?? 'unavailable'}; state schema version: ${replayVersion ?? 'unavailable'}`,
    `Assistant usage (${usage.turns} turns): input=${usage.input}, output=${usage.output}, cache-read=${usage.cacheRead}, cache-write=${usage.cacheWrite}, peak-context=${usage.peakContext}`,
    PI_DIAGNOSTICS_LIMITATION,
    `Advisory duplicate skill names in applicable CWD ancestor .agents/skills directories: ${duplicates.length}`,
    ...duplicates.flatMap(([name, group]) => [
      `- ${name}:`,
      ...group.map((definition) => `  - ${definition.filePath}`),
    ]),
  ].join('\n');
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
  const promptCwd = cwd.replace(/\\/g, '/');
  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : '';
  const contextFiles = providedContextFiles ?? [];
  const skills = providedSkills ?? [];
  const tools = selectedTools || ['read', 'bash', 'edit', 'write'];
  const hasBash = tools.includes('bash');

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
    prompt = appendProjectContext(prompt, contextFiles);

    const customPromptHasRead =
      !selectedTools || selectedTools.includes('read');
    if (customPromptHasRead) {
      prompt += formatSkillsForPrompt(skills);
    }

    prompt += `\nCurrent date: ${currentDate()}`;
    prompt += `\nCurrent working directory: ${promptCwd}`;
    return prompt;
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
  const hasRead = tools.includes('read');

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
  addGuideline('Be concise in your responses');
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

  prompt = appendProjectContext(prompt, contextFiles);
  if (hasRead) {
    prompt += formatSkillsForPrompt(skills);
  }

  prompt += `\nCurrent date: ${currentDate()}`;
  prompt += `\nCurrent working directory: ${promptCwd}`;
  return prompt;
}

export default function systemPrompt(pi: ExtensionAPI) {
  let contextCalls = 0;
  let lastContext = summarizeContextMessages([], contextCalls);

  pi.on('session_start', () => {
    contextCalls = 0;
    lastContext = summarizeContextMessages([], contextCalls);
  });

  pi.on('context', (event) => {
    contextCalls++;
    lastContext = summarizeContextMessages(event.messages, contextCalls);
  });

  pi.on('before_agent_start', (event, ctx) => {
    const rebuiltPrompt = buildSystemPrompt(
      event.systemPromptOptions,
      String(ctx.mode),
    );
    return { systemPrompt: rebuiltPrompt };
  });

  pi.registerCommand('prompt-info', {
    description: 'Show aggregate prompt, context, skill, and usage diagnostics',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const options = ctx.getSystemPromptOptions();
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.message);
      const info = formatPromptInfo(
        options,
        ctx.getSystemPrompt(),
        lastContext,
        aggregateAssistantUsage(messages),
        ctx.isProjectTrusted()
          ? discoverAncestorSkillDefinitions(options.cwd)
          : [],
        todoStateVersion(branch),
      );
      if (ctx.hasUI) {
        ctx.ui.notify(info, 'info');
        return;
      }
      console.log(info);
    },
  });
}
