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
  rootPath: Type.String({ minLength: 1, maxLength: MAX_PATH }),
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
    rootPath: Type.String({ minLength: 1, maxLength: MAX_PATH }),
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

export const ProjectRenameCommandSchema = Type.Object(
  {
    commandId: CommandIdSchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);
export type ProjectRenameCommand = Static<typeof ProjectRenameCommandSchema>;

/** Adopt an existing unassigned Pi transcript without launching a runtime. */
export const SessionAdoptCommandSchema = Type.Object(
  {
    commandId: CommandIdSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    checkoutId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID })),
  },
  { additionalProperties: false },
);
export type SessionAdoptCommand = Static<typeof SessionAdoptCommandSchema>;

export const ThreadCreateCommandSchema = Type.Object(
  {
    commandId: CommandIdSchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    prompt: Type.String({ maxLength: MAX_TEXT }),
    checkoutId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID })),
    isolation: Type.Optional(
      Type.Union([Type.Literal('worktree'), Type.Literal('main')]),
    ),
    /** Worktree source: WIP (default), a durable current HEAD, or a validated local ref. */
    base: Type.Optional(
      Type.Union([Type.Literal('work'), Type.Literal('head')]),
    ),
    baseRef: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 512,
        pattern: '^[^\\u0000-\\u001F\\u007F]+$',
      }),
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal('read'), Type.Literal('write')]),
    ),
    model: Type.Optional(ModelSelectionSchema),
    runtimeProvider: Type.Optional(Type.Literal('extension-bridge')),
  },
  { additionalProperties: false },
);
export type ThreadCreateCommand = Static<typeof ThreadCreateCommandSchema>;

/** Machine-facing create request; unlike browser create, title is authoritative. */
export const ExternalThreadCreateCommandSchema = Type.Object(
  {
    externalRef: Type.String({
      minLength: 1,
      maxLength: MAX_ID,
      pattern: '^[^\\u0000-\\u001F\\u007F]*$',
    }),
    title: Type.String({
      minLength: 1,
      maxLength: 512,
      pattern: '.*\\S.*',
    }),
    prompt: Type.String({
      minLength: 1,
      maxLength: MAX_TEXT,
      pattern: '.*\\S.*',
    }),
    checkoutId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID })),
    isolation: Type.Optional(
      Type.Union([Type.Literal('worktree'), Type.Literal('main')]),
    ),
    base: Type.Optional(
      Type.Union([Type.Literal('work'), Type.Literal('head')]),
    ),
    baseRef: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 512,
        pattern: '^[^\\u0000-\\u001F\\u007F]+$',
      }),
    ),
    model: Type.Optional(ModelSelectionSchema),
  },
  { additionalProperties: false },
);
export type ExternalThreadCreateCommand = Static<
  typeof ExternalThreadCreateCommandSchema
>;

export const RetryCommandSchema = Type.Object(
  {
    commandId: CommandIdSchema,
    prompt: Type.Optional(Type.String({ maxLength: MAX_TEXT })),
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

export const RestoreThreadCommandSchema = Type.Object(
  { commandId: CommandIdSchema },
  { additionalProperties: false },
);
export type RestoreThreadCommand = Static<typeof RestoreThreadCommandSchema>;

export const RegenerateThreadTitleCommandSchema = Type.Object(
  { commandId: CommandIdSchema },
  { additionalProperties: false },
);
export type RegenerateThreadTitleCommand = Static<
  typeof RegenerateThreadTitleCommandSchema
>;

export const PinThreadCommandSchema = Type.Object(
  { commandId: CommandIdSchema },
  { additionalProperties: false },
);
export type PinThreadCommand = Static<typeof PinThreadCommandSchema>;

export const UnpinThreadCommandSchema = Type.Object(
  { commandId: CommandIdSchema },
  { additionalProperties: false },
);
export type UnpinThreadCommand = Static<typeof UnpinThreadCommandSchema>;

export const SettleThreadCommandSchema = Type.Object(
  { commandId: CommandIdSchema },
  { additionalProperties: false },
);
export type SettleThreadCommand = Static<typeof SettleThreadCommandSchema>;
export const UnsettleThreadCommandSchema = Type.Object(
  { commandId: CommandIdSchema },
  { additionalProperties: false },
);
export type UnsettleThreadCommand = Static<typeof UnsettleThreadCommandSchema>;
