import { createHash } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  BuildSystemPromptOptions,
  ToolInfo,
} from '@earendil-works/pi-coding-agent';
import { filterGlobalContextFiles, formatSkillsForPrompt } from './composition';

export interface SizeEstimate {
  characters: number;
  tokens: number;
}

export interface ContextDiagnostics {
  calls: number;
  messages: number;
  retainedToolResults: SizeEstimate & { count: number };
  customMessages: SizeEstimate & { count: number };
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

export function summarizeContextMessages(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
  calls = 1,
): ContextDiagnostics {
  let toolCount = 0;
  let toolCharacters = 0;
  let customCount = 0;
  let customCharacters = 0;
  for (const message of messages) {
    if (message.role === 'toolResult') {
      toolCount++;
      toolCharacters += textCharacters(message.content);
    } else if (message.role === 'custom') {
      customCount++;
      customCharacters += textCharacters(message.content);
    }
  }
  return {
    calls,
    messages: messages.length,
    retainedToolResults: {
      count: toolCount,
      ...estimateSize('x'.repeat(toolCharacters)),
    },
    customMessages: {
      count: customCount,
      ...estimateSize('x'.repeat(customCharacters)),
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

function sizeLine(label: string, size: SizeEstimate): string {
  return `${label}: ${size.characters} chars (~${size.tokens} tokens)`;
}

export function formatPromptInfo(
  options: BuildSystemPromptOptions,
  emittedPrompt: string,
  context: ContextDiagnostics,
  usage: UsageDiagnostics,
  toolInfo: readonly ToolInfo[] = [],
): string {
  const contextFiles = filterGlobalContextFiles(
    options.contextFiles ?? [],
    options.cwd,
  );
  const allSkills = options.skills ?? [];
  const visibleSkills = allSkills.filter(
    (skill) => !skill.disableModelInvocation,
  );
  const tools = options.selectedTools ?? ['read', 'bash', 'edit', 'write'];
  const skillIndex = tools.includes('read')
    ? formatSkillsForPrompt(visibleSkills)
    : '';
  const customPromptSize =
    typeof options.customPrompt === 'string' ? options.customPrompt.length : 0;
  const appendSize =
    typeof options.appendSystemPrompt === 'string'
      ? options.appendSystemPrompt.length
      : 0;

  return [
    `CWD: ${options.cwd}`,
    'Token estimates use the aggregate heuristic of 4 characters/token.',
    sizeLine(
      'Last emitted canonical system prompt',
      estimateSize(emittedPrompt),
    ),
    `Ignored direct prompt inputs: customPrompt=${customPromptSize} chars, appendSystemPrompt=${appendSize} chars`,
    `Structured tool prompt guidelines: ${options.promptGuidelines?.length ?? 0}`,
    `Context files: ${contextFiles.length}`,
    ...contextFiles.map(
      (file) =>
        `- ${file.path}: ${sizeLine('', estimateSize(file.content)).slice(2)}`,
    ),
    sizeLine('Visible skill-index contribution', estimateSize(skillIndex)),
    `Loaded skills: ${allSkills.length} (${visibleSkills.length} model-visible, ${allSkills.length - visibleSkills.length} explicit-only)`,
    ...allSkills.map(
      (skill) =>
        `- ${skill.name}: ${skill.filePath} [source=${skill.sourceInfo.source}, scope=${skill.sourceInfo.scope}${skill.disableModelInvocation ? ', model-invocation=disabled' : ''}]`,
    ),
    `Active tools: ${tools.join(', ') || '(none)'}`,
    `Tool parameter schemas: ${toolInfo.length} runtime definition(s).`,
    ...toolInfo.map((tool) => {
      const schema = JSON.stringify(tool.parameters);
      const hash = createHash('sha256')
        .update(schema)
        .digest('hex')
        .slice(0, 12);
      return `- ${tool.name}: ${Buffer.byteLength(schema, 'utf8')} schema bytes, sha256 ${hash}, source=${tool.sourceInfo.source}`;
    }),
    `Latest context observation: ${context.calls} call(s), ${context.messages} messages`,
    sizeLine(
      `Retained tool results (${context.retainedToolResults.count})`,
      context.retainedToolResults,
    ),
    sizeLine(
      `Custom context messages (${context.customMessages.count})`,
      context.customMessages,
    ),
    `Assistant usage (${usage.turns} turns): input=${usage.input}, output=${usage.output}, cache-read=${usage.cacheRead}, cache-write=${usage.cacheWrite}, peak-context=${usage.peakContext}`,
  ].join('\n');
}
