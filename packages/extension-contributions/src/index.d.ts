/**
 * Framework-free extension contribution contracts.
 *
 * This package is deliberately the narrow boundary between a Pi extension and
 * a presentation surface.  It contains schemas and pure selectors only: it
 * must not import React, Pi TUI, Fastify, sockets, or a filesystem loader.
 */
import { type Static, type TSchema, Type } from 'typebox';
export declare const EXTENSION_CONTRIBUTIONS_VERSION = 1;
export declare const UNKNOWN_FIELD_POLICY: 'reject';
export type UnknownFieldPolicy = typeof UNKNOWN_FIELD_POLICY;
export declare const CapabilitySummarySchema: Type.TObject<{
  id: Type.TString;
  version: Type.TString;
  available: Type.TOptional<Type.TBoolean>;
  summary: Type.TOptional<Type.TString>;
}>;
export type CapabilitySummary = Static<typeof CapabilitySummarySchema>;
export declare const AvailabilityRuleSchema: Type.TObject<{
  /** All listed capability IDs must be advertised and available. */
  requires: Type.TOptional<Type.TReadonly<Type.TArray<Type.TString>>>;
  online: Type.TOptional<Type.TBoolean>;
  liveStates: Type.TOptional<
    Type.TReadonly<
      Type.TArray<
        Type.TUnion<
          [
            Type.TLiteral<'idle'>,
            Type.TLiteral<'working'>,
            Type.TLiteral<'waiting'>,
            Type.TLiteral<'aborting'>,
            Type.TLiteral<'stopping'>,
            Type.TLiteral<'failed'>,
          ]
        >
      >
    >
  >;
  /** Require at least one pending interaction, or require none. */
  pendingInteraction: Type.TOptional<Type.TBoolean>;
}>;
export type AvailabilityRule = Static<typeof AvailabilityRuleSchema>;
export declare const ActionSummarySchema: Type.TObject<{
  id: Type.TString;
  title: Type.TOptional<Type.TString>;
  description: Type.TOptional<Type.TString>;
  availability: Type.TOptional<
    Type.TObject<{
      /** All listed capability IDs must be advertised and available. */
      requires: Type.TOptional<Type.TReadonly<Type.TArray<Type.TString>>>;
      online: Type.TOptional<Type.TBoolean>;
      liveStates: Type.TOptional<
        Type.TReadonly<
          Type.TArray<
            Type.TUnion<
              [
                Type.TLiteral<'idle'>,
                Type.TLiteral<'working'>,
                Type.TLiteral<'waiting'>,
                Type.TLiteral<'aborting'>,
                Type.TLiteral<'stopping'>,
                Type.TLiteral<'failed'>,
              ]
            >
          >
        >
      >;
      /** Require at least one pending interaction, or require none. */
      pendingInteraction: Type.TOptional<Type.TBoolean>;
    }>
  >;
  /** False (the safe default) means duplicate IDs must never be replayed. */
  idempotent: Type.TOptional<Type.TBoolean>;
}>;
export type ActionSummary = Static<typeof ActionSummarySchema>;
export declare const ActionDescriptorSchema: Type.TObject<{
  id: Type.TString;
  title: Type.TOptional<Type.TString>;
  description: Type.TOptional<Type.TString>;
  inputSchema: Type.TUnknown;
  outputSchema: Type.TOptional<Type.TUnknown>;
  availability: Type.TOptional<
    Type.TObject<{
      /** All listed capability IDs must be advertised and available. */
      requires: Type.TOptional<Type.TReadonly<Type.TArray<Type.TString>>>;
      online: Type.TOptional<Type.TBoolean>;
      liveStates: Type.TOptional<
        Type.TReadonly<
          Type.TArray<
            Type.TUnion<
              [
                Type.TLiteral<'idle'>,
                Type.TLiteral<'working'>,
                Type.TLiteral<'waiting'>,
                Type.TLiteral<'aborting'>,
                Type.TLiteral<'stopping'>,
                Type.TLiteral<'failed'>,
              ]
            >
          >
        >
      >;
      /** Require at least one pending interaction, or require none. */
      pendingInteraction: Type.TOptional<Type.TBoolean>;
    }>
  >;
  idempotent: Type.TOptional<Type.TBoolean>;
}>;
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
export declare const RendererModeSchema: Type.TUnion<
  [
    Type.TLiteral<'interaction'>,
    Type.TLiteral<'activity'>,
    Type.TLiteral<'inspector'>,
    Type.TLiteral<'generic'>,
  ]
>;
export type RendererMode = Static<typeof RendererModeSchema>;
export declare const RendererDescriptorSchema: Type.TObject<{
  id: Type.TString;
  mode: Type.TUnion<
    [
      Type.TLiteral<'interaction'>,
      Type.TLiteral<'activity'>,
      Type.TLiteral<'inspector'>,
      Type.TLiteral<'generic'>,
    ]
  >;
  inputSchema: Type.TUnknown;
  title: Type.TOptional<Type.TString>;
  summary: Type.TOptional<Type.TString>;
}>;
export interface RendererDescriptor {
  readonly id: string;
  readonly mode: RendererMode;
  readonly inputSchema: TSchema;
  readonly title?: string;
  readonly summary?: string;
}
export declare const InspectorDescriptorSchema: Type.TObject<{
  id: Type.TString;
  inputSchema: Type.TUnknown;
  title: Type.TOptional<Type.TString>;
  summary: Type.TOptional<Type.TString>;
}>;
export interface InspectorDescriptor {
  readonly id: string;
  readonly inputSchema: TSchema;
  readonly title?: string;
  readonly summary?: string;
}
export declare const InteractionDescriptorSchema: Type.TObject<{
  id: Type.TString;
  rendererId: Type.TString;
  viewModelSchema: Type.TUnknown;
  answerActionId: Type.TString;
  cancelActionId: Type.TString;
}>;
export interface InteractionDescriptor {
  readonly id: string;
  readonly rendererId: string;
  readonly viewModelSchema: TSchema;
  readonly answerActionId: string;
  readonly cancelActionId: string;
}
export declare const ExtensionManifestSummarySchema: Type.TObject<{
  id: Type.TString;
  version: Type.TString;
  title: Type.TOptional<Type.TString>;
  actions: Type.TReadonly<
    Type.TArray<
      Type.TObject<{
        id: Type.TString;
        title: Type.TOptional<Type.TString>;
        description: Type.TOptional<Type.TString>;
        availability: Type.TOptional<
          Type.TObject<{
            /** All listed capability IDs must be advertised and available. */
            requires: Type.TOptional<Type.TReadonly<Type.TArray<Type.TString>>>;
            online: Type.TOptional<Type.TBoolean>;
            liveStates: Type.TOptional<
              Type.TReadonly<
                Type.TArray<
                  Type.TUnion<
                    [
                      Type.TLiteral<'idle'>,
                      Type.TLiteral<'working'>,
                      Type.TLiteral<'waiting'>,
                      Type.TLiteral<'aborting'>,
                      Type.TLiteral<'stopping'>,
                      Type.TLiteral<'failed'>,
                    ]
                  >
                >
              >
            >;
            /** Require at least one pending interaction, or require none. */
            pendingInteraction: Type.TOptional<Type.TBoolean>;
          }>
        >;
        /** False (the safe default) means duplicate IDs must never be replayed. */
        idempotent: Type.TOptional<Type.TBoolean>;
      }>
    >
  >;
  renderers: Type.TReadonly<
    Type.TArray<
      Type.TObject<{
        id: Type.TString;
        mode: Type.TUnion<
          [
            Type.TLiteral<'interaction'>,
            Type.TLiteral<'activity'>,
            Type.TLiteral<'inspector'>,
            Type.TLiteral<'generic'>,
          ]
        >;
        title: Type.TOptional<Type.TString>;
      }>
    >
  >;
  inspectors: Type.TOptional<
    Type.TReadonly<
      Type.TArray<
        Type.TObject<{
          id: Type.TString;
          title: Type.TOptional<Type.TString>;
        }>
      >
    >
  >;
  interactions: Type.TOptional<
    Type.TReadonly<
      Type.TArray<
        Type.TObject<{
          id: Type.TString;
          rendererId: Type.TString;
          answerActionId: Type.TString;
          cancelActionId: Type.TString;
        }>
      >
    >
  >;
}>;
export type ExtensionManifestSummary = Static<
  typeof ExtensionManifestSummarySchema
>;
export declare const ExtensionManifestSchema: Type.TObject<{
  id: Type.TString;
  version: Type.TString;
  title: Type.TOptional<Type.TString>;
  actions: Type.TReadonly<
    Type.TArray<
      Type.TObject<{
        id: Type.TString;
        title: Type.TOptional<Type.TString>;
        description: Type.TOptional<Type.TString>;
        inputSchema: Type.TUnknown;
        outputSchema: Type.TOptional<Type.TUnknown>;
        availability: Type.TOptional<
          Type.TObject<{
            /** All listed capability IDs must be advertised and available. */
            requires: Type.TOptional<Type.TReadonly<Type.TArray<Type.TString>>>;
            online: Type.TOptional<Type.TBoolean>;
            liveStates: Type.TOptional<
              Type.TReadonly<
                Type.TArray<
                  Type.TUnion<
                    [
                      Type.TLiteral<'idle'>,
                      Type.TLiteral<'working'>,
                      Type.TLiteral<'waiting'>,
                      Type.TLiteral<'aborting'>,
                      Type.TLiteral<'stopping'>,
                      Type.TLiteral<'failed'>,
                    ]
                  >
                >
              >
            >;
            /** Require at least one pending interaction, or require none. */
            pendingInteraction: Type.TOptional<Type.TBoolean>;
          }>
        >;
        idempotent: Type.TOptional<Type.TBoolean>;
      }>
    >
  >;
  renderers: Type.TReadonly<
    Type.TArray<
      Type.TObject<{
        id: Type.TString;
        mode: Type.TUnion<
          [
            Type.TLiteral<'interaction'>,
            Type.TLiteral<'activity'>,
            Type.TLiteral<'inspector'>,
            Type.TLiteral<'generic'>,
          ]
        >;
        inputSchema: Type.TUnknown;
        title: Type.TOptional<Type.TString>;
        summary: Type.TOptional<Type.TString>;
      }>
    >
  >;
  inspectors: Type.TOptional<
    Type.TReadonly<
      Type.TArray<
        Type.TObject<{
          id: Type.TString;
          inputSchema: Type.TUnknown;
          title: Type.TOptional<Type.TString>;
          summary: Type.TOptional<Type.TString>;
        }>
      >
    >
  >;
  interactions: Type.TOptional<
    Type.TReadonly<
      Type.TArray<
        Type.TObject<{
          id: Type.TString;
          rendererId: Type.TString;
          viewModelSchema: Type.TUnknown;
          answerActionId: Type.TString;
          cancelActionId: Type.TString;
        }>
      >
    >
  >;
}>;
export interface ExtensionManifest {
  readonly id: string;
  readonly version: string;
  readonly title?: string;
  readonly actions: readonly ActionDescriptor[];
  readonly renderers: readonly RendererDescriptor[];
  readonly inspectors?: readonly InspectorDescriptor[];
  readonly interactions?: readonly InteractionDescriptor[];
}
export declare const RuntimeCapabilitySnapshotSchema: Type.TObject<{
  version: Type.TLiteral<1>;
  capabilities: Type.TReadonly<
    Type.TArray<
      Type.TObject<{
        id: Type.TString;
        version: Type.TString;
        available: Type.TOptional<Type.TBoolean>;
        summary: Type.TOptional<Type.TString>;
      }>
    >
  >;
  manifests: Type.TReadonly<
    Type.TArray<
      Type.TObject<{
        id: Type.TString;
        version: Type.TString;
        title: Type.TOptional<Type.TString>;
        actions: Type.TReadonly<
          Type.TArray<
            Type.TObject<{
              id: Type.TString;
              title: Type.TOptional<Type.TString>;
              description: Type.TOptional<Type.TString>;
              availability: Type.TOptional<
                Type.TObject<{
                  /** All listed capability IDs must be advertised and available. */
                  requires: Type.TOptional<
                    Type.TReadonly<Type.TArray<Type.TString>>
                  >;
                  online: Type.TOptional<Type.TBoolean>;
                  liveStates: Type.TOptional<
                    Type.TReadonly<
                      Type.TArray<
                        Type.TUnion<
                          [
                            Type.TLiteral<'idle'>,
                            Type.TLiteral<'working'>,
                            Type.TLiteral<'waiting'>,
                            Type.TLiteral<'aborting'>,
                            Type.TLiteral<'stopping'>,
                            Type.TLiteral<'failed'>,
                          ]
                        >
                      >
                    >
                  >;
                  /** Require at least one pending interaction, or require none. */
                  pendingInteraction: Type.TOptional<Type.TBoolean>;
                }>
              >;
              /** False (the safe default) means duplicate IDs must never be replayed. */
              idempotent: Type.TOptional<Type.TBoolean>;
            }>
          >
        >;
        renderers: Type.TReadonly<
          Type.TArray<
            Type.TObject<{
              id: Type.TString;
              mode: Type.TUnion<
                [
                  Type.TLiteral<'interaction'>,
                  Type.TLiteral<'activity'>,
                  Type.TLiteral<'inspector'>,
                  Type.TLiteral<'generic'>,
                ]
              >;
              title: Type.TOptional<Type.TString>;
            }>
          >
        >;
        inspectors: Type.TOptional<
          Type.TReadonly<
            Type.TArray<
              Type.TObject<{
                id: Type.TString;
                title: Type.TOptional<Type.TString>;
              }>
            >
          >
        >;
        interactions: Type.TOptional<
          Type.TReadonly<
            Type.TArray<
              Type.TObject<{
                id: Type.TString;
                rendererId: Type.TString;
                answerActionId: Type.TString;
                cancelActionId: Type.TString;
              }>
            >
          >
        >;
      }>
    >
  >;
}>;
export type RuntimeCapabilitySnapshot = Static<
  typeof RuntimeCapabilitySnapshotSchema
>;
export declare const ActionInvocationSchema: Type.TObject<{
  /** Caller-owned stable ID. It is never generated by a retrying adapter. */
  id: Type.TString;
  type: Type.TLiteral<'action.invoke'>;
  actionId: Type.TString;
  input: Type.TUnknown;
}>;
export type ActionInvocation = Static<typeof ActionInvocationSchema>;
export type ContributionState = {
  readonly online?: boolean;
  readonly liveState?: string;
  readonly pendingInteractions?: number;
};
export declare class ContributionError extends Error {
  readonly code:
    | 'invalid-manifest'
    | 'invalid-capability-snapshot'
    | 'unknown-action'
    | 'unknown-capability'
    | 'unavailable-action'
    | 'invalid-action-input'
    | 'invalid-action-output'
    | 'duplicate-action-id';
  constructor(code: ContributionError['code'], message: string);
}
/** A TypeBox schema is data, but only schema-shaped objects are accepted. */
export declare function isTypeBoxSchema(value: unknown): value is TSchema;
export declare function parseExtensionManifest(
  value: unknown,
): ExtensionManifest;
export declare function tryParseExtensionManifest(
  value: unknown,
): ExtensionManifest | undefined;
export declare function parseCapabilitySummary(
  value: unknown,
): CapabilitySummary;
export declare function summarizeManifest(
  manifest: ExtensionManifest,
): ExtensionManifestSummary;
export declare function createRuntimeCapabilitySnapshot(
  manifests: readonly ExtensionManifest[],
  capabilities?: readonly CapabilitySummary[],
): RuntimeCapabilitySnapshot;
export declare function parseRuntimeCapabilitySnapshot(
  value: unknown,
): RuntimeCapabilitySnapshot;
export declare function tryParseRuntimeCapabilitySnapshot(
  value: unknown,
): RuntimeCapabilitySnapshot | undefined;
/** Invalid/absent capability data is an empty capability set, never a crash. */
export declare function safeRuntimeCapabilitySnapshot(
  value: unknown,
): RuntimeCapabilitySnapshot;
export declare function capabilityIsAvailable(
  snapshot: RuntimeCapabilitySnapshot | undefined,
  id: string,
): boolean;
export declare function isActionAvailable(
  action:
    | Pick<ActionDescriptor, 'availability'>
    | Pick<ActionSummary, 'availability'>,
  snapshot: RuntimeCapabilitySnapshot | undefined,
  state?: ContributionState,
): boolean;
export declare function selectAvailableActions(
  manifests: readonly (ExtensionManifest | ExtensionManifestSummary)[],
  snapshot: RuntimeCapabilitySnapshot | undefined,
  state?: ContributionState,
): readonly (ActionDescriptor | ActionSummary)[];
export declare function findActionDescriptor(
  manifests: readonly ExtensionManifest[],
  actionId: string,
): ActionDescriptor | undefined;
export declare function selectAvailableRenderers(
  manifests: readonly (ExtensionManifest | ExtensionManifestSummary)[],
): readonly (
  | RendererDescriptor
  | ExtensionManifestSummary['renderers'][number]
)[];
export declare function findRendererDescriptor(
  manifests: readonly ExtensionManifest[],
  rendererId: string,
): RendererDescriptor | undefined;
export declare function parseActionInput(
  action: Pick<ActionDescriptor, 'id' | 'inputSchema'>,
  input: unknown,
): unknown;
export declare function parseActionOutput(
  action: Pick<ActionDescriptor, 'id' | 'outputSchema'>,
  output: unknown,
): unknown;
export declare function parseActionInvocation(value: unknown): ActionInvocation;
export declare function tryParseActionInvocation(
  value: unknown,
): ActionInvocation | undefined;
export type ContributionActionHandler = (
  invocation: ActionInvocation,
) => Promise<unknown> | unknown;
export declare function actionSummary(action: ActionDescriptor): ActionSummary;
