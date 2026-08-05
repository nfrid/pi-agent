import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  type InteractionDescriptor,
  type RendererDescriptor,
} from '@pi-dashboard/extension-contributions';
import { Type } from 'typebox';

export const ASK_USER_CAPABILITY_ID = 'interaction.ask_user';
export const ASK_USER_RENDERER_ID = 'ask-user.question';
export const ASK_USER_ANSWER_ACTION_ID = 'ask-user.answer';
export const ASK_USER_CANCEL_ACTION_ID = 'ask-user.cancel';

export const AskUserAnswerInputSchema = Type.Object(
  {
    interactionId: Type.String({ minLength: 1, maxLength: 256 }),
    answer: Type.String({ minLength: 1, maxLength: 10_000 }),
  },
  { additionalProperties: false },
);
export const AskUserCancelInputSchema = Type.Object(
  { interactionId: Type.String({ minLength: 1, maxLength: 256 }) },
  { additionalProperties: false },
);
export const AskUserViewModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    question: Type.String({ minLength: 1, maxLength: 20_000 }),
    choices: Type.Array(Type.Unknown(), { maxItems: 128 }),
    allowCustom: Type.Boolean(),
    customLabel: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const askUserInteraction: InteractionDescriptor = {
  id: 'ask-user.question',
  rendererId: ASK_USER_RENDERER_ID,
  viewModelSchema: AskUserViewModelSchema,
  answerActionId: ASK_USER_ANSWER_ACTION_ID,
  cancelActionId: ASK_USER_CANCEL_ACTION_ID,
};

export const askUserRenderer: RendererDescriptor = {
  id: ASK_USER_RENDERER_ID,
  mode: 'interaction',
  inputSchema: AskUserViewModelSchema,
  title: 'Ask user',
  summary: 'A question with choices or a bounded custom answer.',
};

export const askUserManifest: ExtensionManifest = {
  id: 'ask-user',
  version: '1',
  title: 'Ask user',
  actions: [
    {
      id: ASK_USER_ANSWER_ACTION_ID,
      title: 'Answer question',
      inputSchema: AskUserAnswerInputSchema,
      availability: {
        requires: [ASK_USER_CAPABILITY_ID],
        pendingInteraction: true,
      },
    },
    {
      id: ASK_USER_CANCEL_ACTION_ID,
      title: 'Cancel question',
      inputSchema: AskUserCancelInputSchema,
      availability: {
        requires: [ASK_USER_CAPABILITY_ID],
        pendingInteraction: true,
      },
    },
  ],
  renderers: [askUserRenderer],
  interactions: [askUserInteraction],
};

export const askUserCapabilitySnapshot = createRuntimeCapabilitySnapshot(
  [askUserManifest],
  [
    {
      id: ASK_USER_CAPABILITY_ID,
      version: '1',
      available: true,
      summary: 'Broker-backed user question and answer interaction.',
    },
  ],
);
