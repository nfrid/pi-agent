import { type Static, Type } from 'typebox';
import { MAX_ID, MAX_PATH, MAX_TEXT } from './limits.js';
import { ModelSelectionSchema } from './orchestration-contracts.js';

/** Command identifiers are persisted receipts, not transport frame IDs. */
export const CommandIdSchema = Type.String({
  minLength: 1,
  maxLength: MAX_ID,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$',
});
export type CommandId = Static<typeof CommandIdSchema>;

const ProjectOptions = {
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  rootPath: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PATH })),
  workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  defaultBaseBranch: Type.Optional(
    Type.String({ minLength: 1, maxLength: 512 }),
  ),
  defaultModel: Type.Optional(ModelSelectionSchema),
  defaultIsolation: Type.Optional(
    Type.Union([Type.Literal('worktree'), Type.Literal('main')]),
  ),
  maxParallelRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
};

export const ProjectCreateCommandSchema = Type.Object(
  { commandId: CommandIdSchema, ...ProjectOptions },
  { additionalProperties: false },
);
export type ProjectCreateCommand = Static<typeof ProjectCreateCommandSchema>;

export const ProjectAdoptCommandSchema = Type.Object(
  {
    commandId: CommandIdSchema,
    workspaceId: Type.String({ minLength: 1, maxLength: 256 }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    defaultBaseBranch: Type.Optional(
      Type.String({ minLength: 1, maxLength: 512 }),
    ),
    defaultModel: Type.Optional(ModelSelectionSchema),
    defaultIsolation: Type.Optional(
      Type.Union([Type.Literal('worktree'), Type.Literal('main')]),
    ),
    maxParallelRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
  },
  { additionalProperties: false },
);
export type ProjectAdoptCommand = Static<typeof ProjectAdoptCommandSchema>;

export const ThreadCreateCommandSchema = Type.Object(
  {
    commandId: CommandIdSchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    prompt: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    checkoutId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID })),
    isolation: Type.Optional(
      Type.Union([Type.Literal('worktree'), Type.Literal('main')]),
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal('read'), Type.Literal('write')]),
    ),
    model: Type.Optional(ModelSelectionSchema),
    runtimeProvider: Type.Optional(
      Type.Union([Type.Literal('extension-bridge'), Type.Literal('pi-server')]),
    ),
  },
  { additionalProperties: false },
);
export type ThreadCreateCommand = Static<typeof ThreadCreateCommandSchema>;

export const RetryCommandSchema = Type.Object(
  {
    commandId: CommandIdSchema,
    prompt: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT })),
    model: Type.Optional(ModelSelectionSchema),
  },
  { additionalProperties: false },
);
export type RetryCommand = Static<typeof RetryCommandSchema>;

export const CancelCommandSchema = Type.Object(
  { commandId: CommandIdSchema },
  { additionalProperties: false },
);
export type CancelCommand = Static<typeof CancelCommandSchema>;

export const CheckoutActionCommandSchema = Type.Object(
  { commandId: CommandIdSchema },
  { additionalProperties: false },
);
export type CheckoutActionCommand = Static<typeof CheckoutActionCommandSchema>;

/** Review is observational; merge/retire use CheckoutActionCommandSchema. */
export const CheckoutReviewCommandSchema = Type.Object(
  {},
  { additionalProperties: false },
);
export type CheckoutReviewCommand = Static<typeof CheckoutReviewCommandSchema>;

export const ArchiveThreadCommandSchema = Type.Object(
  { commandId: CommandIdSchema },
  { additionalProperties: false },
);
export type ArchiveThreadCommand = Static<typeof ArchiveThreadCommandSchema>;
