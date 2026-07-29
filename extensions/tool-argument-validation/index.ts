import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';
import { defineExtension } from '../shared/runtime/extension';

type SchemaObject = TSchema & {
  additionalProperties?: boolean | TSchema;
  unevaluatedProperties?: boolean | TSchema;
};

const strictValidators = new WeakMap<object, Validator>();

function strictRootValidator(parameters: TSchema): Validator {
  const key = parameters as object;
  const cached = strictValidators.get(key);
  if (cached) return cached;

  const schema = parameters as SchemaObject;
  const closesItself =
    schema.additionalProperties !== undefined ||
    schema.unevaluatedProperties !== undefined;
  const validator = Compile(
    closesItself
      ? parameters
      : ({ ...schema, unevaluatedProperties: false } as TSchema),
  );
  strictValidators.set(key, validator);
  return validator;
}

function unexpectedProperty(error: {
  keyword: string;
  params: unknown;
}): string | undefined {
  if (
    error.keyword !== 'additionalProperties' &&
    error.keyword !== 'unevaluatedProperties'
  )
    return undefined;
  const params = error.params as {
    additionalProperties?: string[];
    unevaluatedProperties?: string[];
  };
  return params.additionalProperties?.[0] ?? params.unevaluatedProperties?.[0];
}

export function strictToolArgumentError(
  toolName: string,
  input: unknown,
  parameters: TSchema,
): string | undefined {
  const schema = parameters as SchemaObject;
  const errors = [...strictRootValidator(parameters).Errors(input)];
  if (errors.length === 0) return undefined;
  const unexpected = errors.map(unexpectedProperty);
  const property = unexpected.find(Boolean);
  const typedAdditional =
    typeof schema.additionalProperties === 'object' ||
    typeof schema.unevaluatedProperties === 'object';
  if (property && unexpected.every(Boolean) && !typedAdditional)
    return `Tool "${toolName}" does not support argument "${property}". Remove it and retry.`;
  return `Tool "${toolName}" arguments do not match its declared schema.`;
}

export default defineExtension(
  'tool-argument-validation',
  (pi: ExtensionAPI) => {
    pi.on('tool_call', (event) => {
      const tool = pi
        .getAllTools()
        .find((candidate) => candidate.name === event.toolName);
      if (!tool) return undefined;
      const reason = strictToolArgumentError(
        event.toolName,
        event.input,
        tool.parameters,
      );
      return reason ? { block: true, reason } : undefined;
    });
  },
);
