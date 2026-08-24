import type {
  ExtensionAPI,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { TOOL_ACTION_LABEL_MAX } from '@pi-dashboard/activity-model';
import { type Static, Type } from 'typebox';
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
  ...upstreamDefinition.parameters.properties,
  description: DESCRIPTION_SCHEMA,
});

export type BashDescriptionArguments = Static<typeof bashDescriptionParameters>;

/** Validate before Pi's Value.Convert can coerce a numeric description to text. */
export function validateBashDescriptionArguments(
  args: unknown,
): BashDescriptionArguments {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return args as BashDescriptionArguments;
  const description = (args as Record<string, unknown>).description;
  if (description === undefined) return args as BashDescriptionArguments;
  if (typeof description !== 'string')
    throw new Error(
      'bash description must be a string; omit it or provide a short user-facing description.',
    );
  if (!description.trim())
    throw new Error(
      'bash description must not be blank; omit it or provide a short user-facing description.',
    );
  if (description.length > BASH_DESCRIPTION_MAX_LENGTH)
    throw new Error(
      `bash description must be ${BASH_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    );
  return args as BashDescriptionArguments;
}

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
    prepareArguments: validateBashDescriptionArguments,
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
