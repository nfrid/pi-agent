import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { buildSystemPrompt } from './composition';
import {
  aggregateAssistantUsage,
  formatPromptInfo,
  summarizeContextMessages,
} from './diagnostics';
import { findOuterMetaSkillPath } from './skills';

export {
  buildSystemPrompt,
  filterGlobalContextFiles,
  formatSkillsForPrompt,
} from './composition';
export {
  aggregateAssistantUsage,
  type ContextDiagnostics,
  estimateSize,
  formatPromptInfo,
  type SizeEstimate,
  summarizeContextMessages,
  type UsageDiagnostics,
} from './diagnostics';
export {
  findNearestGitRoot,
  findOuterMetaSkillPath,
  META_ROOT_MARKER,
} from './skills';

const registered = new WeakSet<object>();

export default function systemPrompt(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);
  pi.on('resources_discover', (event) => {
    const skills = findOuterMetaSkillPath(event.cwd);
    return skills ? { skillPaths: [skills] } : undefined;
  });

  let contextCalls = 0;
  let lastContext = summarizeContextMessages([], contextCalls);
  let lastPrompt = '';

  pi.on('session_start', () => {
    contextCalls = 0;
    lastContext = summarizeContextMessages([], contextCalls);
    lastPrompt = '';
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
    lastPrompt = rebuiltPrompt;
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
      const emittedPrompt =
        lastPrompt || buildSystemPrompt(options, String(ctx.mode));
      const info = formatPromptInfo(
        options,
        emittedPrompt,
        lastContext,
        aggregateAssistantUsage(messages),
        pi.getAllTools(),
      );
      if (ctx.hasUI) {
        ctx.ui.notify(info, 'info');
        return;
      }
      console.log(info);
    },
  });
}
