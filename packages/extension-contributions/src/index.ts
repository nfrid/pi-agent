/**
 * Framework-free extension contribution contracts.
 *
 * This package is deliberately the narrow boundary between a Pi extension and
 * a presentation surface.  It contains schemas and pure selectors only: it
 * must not import React, Pi TUI, Fastify, sockets, or a filesystem loader.
 */
import { type Static, type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';

export const EXTENSION_CONTRIBUTIONS_VERSION = 1;
export const UNKNOWN_FIELD_POLICY = 'reject' as const;
export type UnknownFieldPolicy = typeof UNKNOWN_FIELD_POLICY;

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$',
});
const VersionSchema = Type.String({ minLength: 1, maxLength: 64 });
const SchemaSchema = Type.Unknown();

export const CapabilitySummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    version: VersionSchema,
    available: Type.Optional(Type.Boolean()),
    summary: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export type CapabilitySummary = Static<typeof CapabilitySummarySchema>;

export const AvailabilityRuleSchema = Type.Object(
  {
    /** All listed capability IDs must be advertised and available. */
    requires: Type.Optional(
      Type.Readonly(Type.Array(IdentifierSchema, { maxItems: 64 })),
    ),
    online: Type.Optional(Type.Boolean()),
    liveStates: Type.Optional(
      Type.Readonly(
        Type.Array(
          Type.Union([
            Type.Literal('idle'),
            Type.Literal('working'),
            Type.Literal('waiting'),
            Type.Literal('aborting'),
            Type.Literal('stopping'),
            Type.Literal('failed'),
          ]),
          { maxItems: 8 },
        ),
      ),
    ),
    /** Require at least one pending interaction, or require none. */
    pendingInteraction: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type AvailabilityRule = Static<typeof AvailabilityRuleSchema>;

export const ActionSummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    availability: Type.Optional(AvailabilityRuleSchema),
    /** False (the safe default) means duplicate IDs must never be replayed. */
    idempotent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ActionSummary = Static<typeof ActionSummarySchema>;

export const ActionDescriptorSchema = Type.Object(
  {
    id: IdentifierSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    inputSchema: SchemaSchema,
    outputSchema: Type.Optional(SchemaSchema),
    availability: Type.Optional(AvailabilityRuleSchema),
    idempotent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
/** A descriptor retains the actual TypeBox schema for local input validation. */
export interface ActionDescriptor {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: TSchema;
  readonly outputSchema?: TSchema;
  readonly availability?: AvailabilityRule;
  readonly idempotent?: boolean;
}

export const RendererModeSchema = Type.Union([
  Type.Literal('interaction'),
  Type.Literal('activity'),
  Type.Literal('inspector'),
  Type.Literal('generic'),
]);
export type RendererMode = Static<typeof RendererModeSchema>;

export const RendererDescriptorSchema = Type.Object(
  {
    id: IdentifierSchema,
    mode: RendererModeSchema,
    inputSchema: SchemaSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    summary: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export interface RendererDescriptor {
  readonly id: string;
  readonly mode: RendererMode;
  readonly inputSchema: TSchema;
  readonly title?: string;
  readonly summary?: string;
}

export const InspectorDescriptorSchema = Type.Object(
  {
    id: IdentifierSchema,
    inputSchema: SchemaSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    summary: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export interface InspectorDescriptor {
  readonly id: string;
  readonly inputSchema: TSchema;
  readonly title?: string;
  readonly summary?: string;
}

export const InteractionDescriptorSchema = Type.Object(
  {
    id: IdentifierSchema,
    rendererId: IdentifierSchema,
    viewModelSchema: SchemaSchema,
    answerActionId: IdentifierSchema,
    cancelActionId: IdentifierSchema,
  },
  { additionalProperties: false },
);
export interface InteractionDescriptor {
  readonly id: string;
  readonly rendererId: string;
  readonly viewModelSchema: TSchema;
  readonly answerActionId: string;
  readonly cancelActionId: string;
}

export const ExtensionManifestSummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    version: VersionSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    actions: Type.Readonly(Type.Array(ActionSummarySchema, { maxItems: 128 })),
    renderers: Type.Readonly(
      Type.Array(
        Type.Object(
          {
            id: IdentifierSchema,
            mode: RendererModeSchema,
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          },
          { additionalProperties: false },
        ),
        { maxItems: 128 },
      ),
    ),
    inspectors: Type.Optional(
      Type.Readonly(
        Type.Array(
          Type.Object(
            {
              id: IdentifierSchema,
              title: Type.Optional(
                Type.String({ minLength: 1, maxLength: 256 }),
              ),
            },
            { additionalProperties: false },
          ),
          { maxItems: 128 },
        ),
      ),
    ),
    interactions: Type.Optional(
      Type.Readonly(
        Type.Array(
          Type.Object(
            {
              id: IdentifierSchema,
              rendererId: IdentifierSchema,
              answerActionId: IdentifierSchema,
              cancelActionId: IdentifierSchema,
            },
            { additionalProperties: false },
          ),
          { maxItems: 128 },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
export type ExtensionManifestSummary = Static<
  typeof ExtensionManifestSummarySchema
>;

export const ExtensionManifestSchema = Type.Object(
  {
    id: IdentifierSchema,
    version: VersionSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    actions: Type.Readonly(
      Type.Array(ActionDescriptorSchema, { maxItems: 128 }),
    ),
    renderers: Type.Readonly(
      Type.Array(RendererDescriptorSchema, { maxItems: 128 }),
    ),
    inspectors: Type.Optional(
      Type.Readonly(Type.Array(InspectorDescriptorSchema, { maxItems: 128 })),
    ),
    interactions: Type.Optional(
      Type.Readonly(Type.Array(InteractionDescriptorSchema, { maxItems: 128 })),
    ),
  },
  { additionalProperties: false },
);
export interface ExtensionManifest {
  readonly id: string;
  readonly version: string;
  readonly title?: string;
  readonly actions: readonly ActionDescriptor[];
  readonly renderers: readonly RendererDescriptor[];
  readonly inspectors?: readonly InspectorDescriptor[];
  readonly interactions?: readonly InteractionDescriptor[];
}

export const RuntimeCapabilitySnapshotSchema = Type.Object(
  {
    version: Type.Literal(EXTENSION_CONTRIBUTIONS_VERSION),
    capabilities: Type.Readonly(
      Type.Array(CapabilitySummarySchema, { maxItems: 256 }),
    ),
    manifests: Type.Readonly(
      Type.Array(ExtensionManifestSummarySchema, { maxItems: 128 }),
    ),
  },
  { additionalProperties: false },
);
export type RuntimeCapabilitySnapshot = Static<
  typeof RuntimeCapabilitySnapshotSchema
>;

export const ActionInvocationSchema = Type.Object(
  {
    /** Caller-owned stable ID. It is never generated by a retrying adapter. */
    id: Type.String({ minLength: 1, maxLength: 128 }),
    type: Type.Literal('action.invoke'),
    actionId: IdentifierSchema,
    input: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type ActionInvocation = Static<typeof ActionInvocationSchema>;

export type ContributionState = {
  readonly online?: boolean;
  readonly liveState?: string;
  readonly pendingInteractions?: number;
};

export class ContributionError extends Error {
  readonly code:
    | 'invalid-manifest'
    | 'invalid-capability-snapshot'
    | 'unknown-action'
    | 'unknown-capability'
    | 'unavailable-action'
    | 'invalid-action-input'
    | 'invalid-action-output'
    | 'duplicate-action-id';

  constructor(code: ContributionError['code'], message: string) {
    super(message);
    this.name = 'ContributionError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A TypeBox schema is data, but only schema-shaped objects are accepted. */
export function isTypeBoxSchema(value: unknown): value is TSchema {
  if (!isRecord(value)) return false;
  return (
    typeof value.type === 'string' ||
    Array.isArray(value.anyOf) ||
    Array.isArray(value.allOf) ||
    Array.isArray(value.oneOf) ||
    'const' in value ||
    'enum' in value
  );
}

function duplicateIds(values: readonly { id: string }[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id))
      throw new ContributionError(
        'duplicate-action-id',
        `Duplicate ${label} ID: ${value.id}`,
      );
    seen.add(value.id);
  }
}

function validateManifestSchemas(manifest: ExtensionManifest): void {
  for (const action of manifest.actions) {
    if (!isTypeBoxSchema(action.inputSchema))
      throw new ContributionError(
        'invalid-manifest',
        `Action ${action.id} has an invalid input schema.`,
      );
    if (
      action.outputSchema !== undefined &&
      !isTypeBoxSchema(action.outputSchema)
    )
      throw new ContributionError(
        'invalid-manifest',
        `Action ${action.id} has an invalid output schema.`,
      );
  }
  for (const renderer of manifest.renderers)
    if (!isTypeBoxSchema(renderer.inputSchema))
      throw new ContributionError(
        'invalid-manifest',
        `Renderer ${renderer.id} has an invalid input schema.`,
      );
  for (const inspector of manifest.inspectors ?? [])
    if (!isTypeBoxSchema(inspector.inputSchema))
      throw new ContributionError(
        'invalid-manifest',
        `Inspector ${inspector.id} has an invalid input schema.`,
      );
  for (const interaction of manifest.interactions ?? [])
    if (!isTypeBoxSchema(interaction.viewModelSchema))
      throw new ContributionError(
        'invalid-manifest',
        `Interaction ${interaction.id} has an invalid view-model schema.`,
      );
}

export function parseExtensionManifest(value: unknown): ExtensionManifest {
  if (!Value.Check(ExtensionManifestSchema, value))
    throw new ContributionError(
      'invalid-manifest',
      'Extension manifest contains invalid or unknown fields.',
    );
  const manifest = value as unknown as ExtensionManifest;
  try {
    duplicateIds(manifest.actions, 'action');
    duplicateIds(manifest.renderers, 'renderer');
    duplicateIds(manifest.inspectors ?? [], 'inspector');
    duplicateIds(manifest.interactions ?? [], 'interaction');
    validateManifestSchemas(manifest);
  } catch (error) {
    if (error instanceof ContributionError) throw error;
    throw new ContributionError('invalid-manifest', String(error));
  }
  return manifest;
}

export function tryParseExtensionManifest(
  value: unknown,
): ExtensionManifest | undefined {
  try {
    return parseExtensionManifest(value);
  } catch {
    return undefined;
  }
}

export function parseCapabilitySummary(value: unknown): CapabilitySummary {
  if (!Value.Check(CapabilitySummarySchema, value))
    throw new ContributionError(
      'invalid-capability-snapshot',
      'Capability summary contains invalid or unknown fields.',
    );
  return value as CapabilitySummary;
}

export function summarizeManifest(
  manifest: ExtensionManifest,
): ExtensionManifestSummary {
  const parsed = parseExtensionManifest(manifest);
  return {
    id: parsed.id,
    version: parsed.version,
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    actions: parsed.actions.map(
      ({ inputSchema: _input, outputSchema: _output, ...summary }) => summary,
    ),
    renderers: parsed.renderers.map(
      ({ inputSchema: _input, summary: rendererSummary, ...renderer }) => ({
        ...renderer,
        ...(rendererSummary === undefined
          ? {}
          : { title: renderer.title ?? rendererSummary }),
      }),
    ),
    ...(parsed.inspectors
      ? {
          inspectors: parsed.inspectors.map(
            ({ inputSchema: _input, ...inspector }) => inspector,
          ),
        }
      : {}),
    ...(parsed.interactions
      ? {
          interactions: parsed.interactions.map(
            ({ viewModelSchema: _viewModel, ...interaction }) => interaction,
          ),
        }
      : {}),
  } as ExtensionManifestSummary;
}

export function createRuntimeCapabilitySnapshot(
  manifests: readonly ExtensionManifest[],
  capabilities: readonly CapabilitySummary[] = [],
): RuntimeCapabilitySnapshot {
  const parsedManifests = manifests.map(parseExtensionManifest);
  duplicateIds(parsedManifests, 'manifest');
  duplicateIds(capabilities, 'capability');
  if (
    !capabilities.every((capability) =>
      Value.Check(CapabilitySummarySchema, capability),
    )
  )
    throw new ContributionError(
      'invalid-capability-snapshot',
      'Invalid capability summary.',
    );
  return {
    version: EXTENSION_CONTRIBUTIONS_VERSION,
    capabilities: [...capabilities],
    manifests: parsedManifests.map(summarizeManifest),
  };
}

export function parseRuntimeCapabilitySnapshot(
  value: unknown,
): RuntimeCapabilitySnapshot {
  if (!Value.Check(RuntimeCapabilitySnapshotSchema, value))
    throw new ContributionError(
      'invalid-capability-snapshot',
      'Runtime capabilities contain invalid or unknown fields.',
    );
  const snapshot = value as RuntimeCapabilitySnapshot;
  duplicateIds(snapshot.capabilities, 'capability');
  duplicateIds(snapshot.manifests, 'manifest');
  for (const manifest of snapshot.manifests) {
    duplicateIds(manifest.actions, `action in ${manifest.id}`);
    duplicateIds(manifest.renderers, `renderer in ${manifest.id}`);
  }
  return snapshot;
}

export function tryParseRuntimeCapabilitySnapshot(
  value: unknown,
): RuntimeCapabilitySnapshot | undefined {
  try {
    return parseRuntimeCapabilitySnapshot(value);
  } catch {
    return undefined;
  }
}

/** Invalid/absent capability data is an empty capability set, never a crash. */
export function safeRuntimeCapabilitySnapshot(
  value: unknown,
): RuntimeCapabilitySnapshot {
  return (
    tryParseRuntimeCapabilitySnapshot(value) ?? {
      version: EXTENSION_CONTRIBUTIONS_VERSION,
      capabilities: [],
      manifests: [],
    }
  );
}

export function capabilityIsAvailable(
  snapshot: RuntimeCapabilitySnapshot | undefined,
  id: string,
): boolean {
  return Boolean(
    snapshot?.capabilities.some(
      (capability) => capability.id === id && capability.available !== false,
    ),
  );
}

export function isActionAvailable(
  action:
    | Pick<ActionDescriptor, 'availability'>
    | Pick<ActionSummary, 'availability'>,
  snapshot: RuntimeCapabilitySnapshot | undefined,
  state: ContributionState = {},
): boolean {
  const rule = action.availability;
  if (!rule) return true;
  if (rule.requires?.some((id) => !capabilityIsAvailable(snapshot, id)))
    return false;
  if (rule.online !== undefined && state.online !== rule.online) return false;
  if (
    rule.liveStates &&
    (state.liveState === undefined ||
      !rule.liveStates.includes(state.liveState as never))
  )
    return false;
  if (
    rule.pendingInteraction !== undefined &&
    (state.pendingInteractions ?? 0) > 0 !== rule.pendingInteraction
  )
    return false;
  return true;
}

export function selectAvailableActions(
  manifests: readonly (ExtensionManifest | ExtensionManifestSummary)[],
  snapshot: RuntimeCapabilitySnapshot | undefined,
  state: ContributionState = {},
): readonly (ActionDescriptor | ActionSummary)[] {
  return manifests.flatMap((manifest) =>
    manifest.actions.filter((action) =>
      isActionAvailable(action, snapshot, state),
    ),
  );
}

export function findActionDescriptor(
  manifests: readonly ExtensionManifest[],
  actionId: string,
): ActionDescriptor | undefined {
  return manifests
    .flatMap((manifest) => manifest.actions)
    .find((action) => action.id === actionId);
}

export function selectAvailableRenderers(
  manifests: readonly (ExtensionManifest | ExtensionManifestSummary)[],
): readonly (
  | RendererDescriptor
  | ExtensionManifestSummary['renderers'][number]
)[] {
  const result: Array<
    RendererDescriptor | ExtensionManifestSummary['renderers'][number]
  > = [];
  for (const manifest of manifests) result.push(...manifest.renderers);
  return result;
}

export function findRendererDescriptor(
  manifests: readonly ExtensionManifest[],
  rendererId: string,
): RendererDescriptor | undefined {
  return manifests
    .flatMap((manifest) => manifest.renderers)
    .find((renderer) => renderer.id === rendererId);
}

export function parseActionInput(
  action: Pick<ActionDescriptor, 'id' | 'inputSchema'>,
  input: unknown,
): unknown {
  if (
    !isTypeBoxSchema(action.inputSchema) ||
    !Value.Check(action.inputSchema, input)
  )
    throw new ContributionError(
      'invalid-action-input',
      `Invalid input for action ${action.id}.`,
    );
  return input;
}

export function parseActionOutput(
  action: Pick<ActionDescriptor, 'id' | 'outputSchema'>,
  output: unknown,
): unknown {
  if (
    action.outputSchema !== undefined &&
    (!isTypeBoxSchema(action.outputSchema) ||
      !Value.Check(action.outputSchema, output))
  )
    throw new ContributionError(
      'invalid-action-output',
      `Invalid output for action ${action.id}.`,
    );
  return output;
}

export function parseActionInvocation(value: unknown): ActionInvocation {
  if (!Value.Check(ActionInvocationSchema, value))
    throw new ContributionError(
      'invalid-action-input',
      'Action invocation contains invalid or unknown fields.',
    );
  return value as ActionInvocation;
}

export function tryParseActionInvocation(
  value: unknown,
): ActionInvocation | undefined {
  try {
    return parseActionInvocation(value);
  } catch {
    return undefined;
  }
}

export type ContributionActionHandler = (
  invocation: ActionInvocation,
) => Promise<unknown> | unknown;

export function actionSummary(action: ActionDescriptor): ActionSummary {
  const { inputSchema: _input, outputSchema: _output, ...summary } = action;
  return summary;
}
