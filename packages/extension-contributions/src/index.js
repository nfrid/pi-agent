/**
 * Framework-free extension contribution contracts.
 *
 * This package is deliberately the narrow boundary between a Pi extension and
 * a presentation surface.  It contains schemas and pure selectors only: it
 * must not import React, Pi TUI, Fastify, sockets, or a filesystem loader.
 */
import { Type } from 'typebox';
import { Value } from 'typebox/value';
export const EXTENSION_CONTRIBUTIONS_VERSION = 1;
export const UNKNOWN_FIELD_POLICY = 'reject';
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
export const RendererModeSchema = Type.Union([
  Type.Literal('interaction'),
  Type.Literal('activity'),
  Type.Literal('inspector'),
  Type.Literal('generic'),
]);
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
export const InspectorDescriptorSchema = Type.Object(
  {
    id: IdentifierSchema,
    inputSchema: SchemaSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    summary: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
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
export class ContributionError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = 'ContributionError';
    this.code = code;
  }
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** A TypeBox schema is data, but only schema-shaped objects are accepted. */
export function isTypeBoxSchema(value) {
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
function duplicateIds(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value.id))
      throw new ContributionError(
        'duplicate-action-id',
        `Duplicate ${label} ID: ${value.id}`,
      );
    seen.add(value.id);
  }
}
function validateManifestSchemas(manifest) {
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
export function parseExtensionManifest(value) {
  if (!Value.Check(ExtensionManifestSchema, value))
    throw new ContributionError(
      'invalid-manifest',
      'Extension manifest contains invalid or unknown fields.',
    );
  const manifest = value;
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
export function tryParseExtensionManifest(value) {
  try {
    return parseExtensionManifest(value);
  } catch {
    return undefined;
  }
}
export function parseCapabilitySummary(value) {
  if (!Value.Check(CapabilitySummarySchema, value))
    throw new ContributionError(
      'invalid-capability-snapshot',
      'Capability summary contains invalid or unknown fields.',
    );
  return value;
}
export function summarizeManifest(manifest) {
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
  };
}
export function createRuntimeCapabilitySnapshot(manifests, capabilities = []) {
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
export function parseRuntimeCapabilitySnapshot(value) {
  if (!Value.Check(RuntimeCapabilitySnapshotSchema, value))
    throw new ContributionError(
      'invalid-capability-snapshot',
      'Runtime capabilities contain invalid or unknown fields.',
    );
  const snapshot = value;
  duplicateIds(snapshot.capabilities, 'capability');
  duplicateIds(snapshot.manifests, 'manifest');
  for (const manifest of snapshot.manifests) {
    duplicateIds(manifest.actions, `action in ${manifest.id}`);
    duplicateIds(manifest.renderers, `renderer in ${manifest.id}`);
  }
  return snapshot;
}
export function tryParseRuntimeCapabilitySnapshot(value) {
  try {
    return parseRuntimeCapabilitySnapshot(value);
  } catch {
    return undefined;
  }
}
/** Invalid/absent capability data is an empty capability set, never a crash. */
export function safeRuntimeCapabilitySnapshot(value) {
  return (
    tryParseRuntimeCapabilitySnapshot(value) ?? {
      version: EXTENSION_CONTRIBUTIONS_VERSION,
      capabilities: [],
      manifests: [],
    }
  );
}
export function capabilityIsAvailable(snapshot, id) {
  return Boolean(
    snapshot?.capabilities.some(
      (capability) => capability.id === id && capability.available !== false,
    ),
  );
}
export function isActionAvailable(action, snapshot, state = {}) {
  const rule = action.availability;
  if (!rule) return true;
  if (rule.requires?.some((id) => !capabilityIsAvailable(snapshot, id)))
    return false;
  if (rule.online !== undefined && state.online !== rule.online) return false;
  if (
    rule.liveStates &&
    (state.liveState === undefined ||
      !rule.liveStates.includes(state.liveState))
  )
    return false;
  if (
    rule.pendingInteraction !== undefined &&
    (state.pendingInteractions ?? 0) > 0 !== rule.pendingInteraction
  )
    return false;
  return true;
}
export function selectAvailableActions(manifests, snapshot, state = {}) {
  return manifests.flatMap((manifest) =>
    manifest.actions.filter((action) =>
      isActionAvailable(action, snapshot, state),
    ),
  );
}
export function findActionDescriptor(manifests, actionId) {
  return manifests
    .flatMap((manifest) => manifest.actions)
    .find((action) => action.id === actionId);
}
export function selectAvailableRenderers(manifests) {
  const result = [];
  for (const manifest of manifests) result.push(...manifest.renderers);
  return result;
}
export function findRendererDescriptor(manifests, rendererId) {
  return manifests
    .flatMap((manifest) => manifest.renderers)
    .find((renderer) => renderer.id === rendererId);
}
export function parseActionInput(action, input) {
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
export function parseActionOutput(action, output) {
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
export function parseActionInvocation(value) {
  if (!Value.Check(ActionInvocationSchema, value))
    throw new ContributionError(
      'invalid-action-input',
      'Action invocation contains invalid or unknown fields.',
    );
  return value;
}
export function tryParseActionInvocation(value) {
  try {
    return parseActionInvocation(value);
  } catch {
    return undefined;
  }
}
export function actionSummary(action) {
  const { inputSchema: _input, outputSchema: _output, ...summary } = action;
  return summary;
}
