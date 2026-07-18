import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { buildSystemPrompt } from './composition';
import {
  aggregateAssistantUsage,
  formatPromptInfo,
  summarizeContextMessages,
  todoStateVersion,
} from './diagnostics';
import { discoverAncestorSkillDefinitions, workspaceSkillPath } from './skills';
import { delegateToolBoundary } from './tool-boundary';

export { buildSystemPrompt, formatSkillsForPrompt } from './composition';
export {
  aggregateAssistantUsage,
  type ContextDiagnostics,
  estimateSize,
  formatPromptInfo,
  type SizeEstimate,
  summarizeContextMessages,
  todoStateVersion,
  type UsageDiagnostics,
} from './diagnostics';
export {
  formatDelegateRoutingConfig,
  formatDelegateRoutingPrompt,
} from './routing';
export {
  discoverAncestorSkillDefinitions,
  type SkillDefinition,
  workspaceSkillPath,
} from './skills';
export { delegateToolBoundary } from './tool-boundary';

const registered = new WeakSet<object>();

export default function systemPrompt(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);
  if (process.env.PI_DELEGATE_CHILD === '1')
    pi.on('tool_call', (event, ctx) => {
      const reason = delegateToolBoundary(event.toolName, event.input, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    });
  pi.on('resources_discover', (event) => {
    const skills = workspaceSkillPath(event.cwd);
    return skills ? { skillPaths: [skills] } : undefined;
  });

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
