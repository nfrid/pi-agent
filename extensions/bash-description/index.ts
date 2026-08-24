import type {
  ExtensionAPI,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { TOOL_ACTION_LABEL_MAX } from '@pi-dashboard/activity-model';
import { Type } from 'typebox';
import { defineExtension } from '../shared/runtime/extension';

export const BASH_DESCRIPTION_MAX_LENGTH = TOOL_ACTION_LABEL_MAX;

const DESCRIPTION_SCHEMA = Type.Optional(
  Type.String({
    minLength: 1,
    maxLength: BASH_DESCRIPTION_MAX_LENGTH,
    description:
      'Short user-facing account of concrete operations and scope for compound, control-flow, mutating, or otherwise non-obvious commands.',
  }),
);

const upstreamDefinition = createBashToolDefinition('');

export const bashDescriptionParameters = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(
    Type.Number({
      description: 'Timeout in seconds (optional, no default timeout)',
    }),
  ),
  description: DESCRIPTION_SCHEMA,
});

export type BashDescriptionToolDefinition = ToolDefinition<
  typeof bashDescriptionParameters
>;

/**
 * Add the optional call description while leaving execution and rendering to
 * Pi's built-in bash implementation.
 */
export function createBashDescriptionToolDefinition(): BashDescriptionToolDefinition {
  return {
    ...upstreamDefinition,
    parameters: bashDescriptionParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { description: _description, ...upstreamParams } = params;
      return createBashToolDefinition(ctx.cwd).execute(
        toolCallId,
        upstreamParams,
        signal,
        onUpdate,
        ctx,
      );
    },
  } as BashDescriptionToolDefinition;
}

export default defineExtension('bash-description', (pi: ExtensionAPI) => {
  pi.registerTool(createBashDescriptionToolDefinition());
});
