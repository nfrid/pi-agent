import type { Static } from 'typebox';
import { Type } from 'typebox';

export const ChoiceSchema = Type.Object({
  label: Type.String({ description: 'Text shown to the user' }),
  value: Type.Optional(
    Type.String({
      description: 'Value returned to the agent; defaults to label',
    }),
  ),
  description: Type.Optional(
    Type.String({ description: 'Optional muted help text under this choice' }),
  ),
  preview: Type.Optional(
    Type.String({
      description:
        'Optional markdown preview shown when this choice is highlighted. Use for code snippets, diagrams, mockups, or visual comparisons.',
    }),
  ),
});

export const ParamsSchema = Type.Object({
  question: Type.String({ description: 'The question to ask the user' }),
  choices: Type.Optional(
    Type.Array(ChoiceSchema, {
      description:
        'Optional choices. Omit or pass an empty list for a free-form answer.',
    }),
  ),
  allowCustom: Type.Optional(
    Type.Boolean({
      description:
        'Allow the user to type a custom answer when choices are provided. Default: true.',
    }),
  ),
  customLabel: Type.Optional(
    Type.String({
      description:
        'Label for the custom-answer row. Default: Type something else.',
    }),
  ),
});

export type AskUserParams = Static<typeof ParamsSchema>;
export type Choice = Static<typeof ChoiceSchema>;
