import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  BuildSystemPromptOptions,
  ToolInfo,
} from '@earendil-works/pi-coding-agent';
import { buildSystemPrompt, formatSkillsForPrompt } from './composition';
import type { SkillDefinition } from './skills';

const PI_DIAGNOSTICS_LIMITATION =
  'Pi exposes loaded skill winners only. Duplicate definitions below are an advisory filesystem scan, not active collision diagnostics; extensions cannot control /skill resolution or add qualified /skill selection.';

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

const LEGACY_TODO_CONTEXT_TYPES = new Set([
  'lean-todo-replay',
  'lean-todo-replay-v2',
]);
const TODO_STATE_ENTRY_TYPE = 'lean-todo';

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
      message.customType !== undefined &&
      LEGACY_TODO_CONTEXT_TYPES.has(message.customType)
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

export function todoStateVersion(
  entries: ReadonlyArray<{
    type: string;
    customType?: string;
    data?: unknown;
  }>,
): number | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== 'custom' || entry.customType !== TODO_STATE_ENTRY_TYPE)
      continue;
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
  toolInfo: readonly ToolInfo[] = [],
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
    `Tool parameter schemas: ${toolInfo.length} runtime definition(s) exposed.`,
    ...toolInfo.map((tool) => {
      const schema = JSON.stringify(tool.parameters);
      const hash = createHash('sha256')
        .update(schema)
        .digest('hex')
        .slice(0, 12);
      return `- ${tool.name}: ${Buffer.byteLength(schema, 'utf8')} schema bytes, sha256 ${hash}, source=${tool.sourceInfo.source}`;
    }),
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
