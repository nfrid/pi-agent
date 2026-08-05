import {
  parseRuntimeCapabilitySnapshot as parseExtensionCapabilitySnapshot,
  parseExtensionSurfaceList,
} from '@pi-dashboard/extension-contributions';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { MAX_ID, MAX_PATH, SESSION_NAME_MAX_LENGTH } from './limits.js';
import {
  type BridgeCommand,
  BridgeCommandSchema,
  type BridgeEvent,
  BridgeEventSchema,
  type BridgeFrame,
  BridgeFrameSchema,
  type BridgeImageAttachment,
  BridgeImageAttachmentSchema,
  type BrowserSnapshot,
  BrowserSnapshotSchema,
  type DashboardEventEnvelope,
  DashboardEventEnvelopeSchema,
  type DashboardMessage,
  DashboardMessageSchema,
  type DashboardStreamMessage,
  DashboardStreamMessageSchema,
  type InteractionSnapshot,
  InteractionSnapshotSchema,
  MAX_FRAME_BYTES,
  type NormalizedMessagePayload,
  NormalizedMessagePayloadSchema,
  type NormalizedToolPayload,
  NormalizedToolPayloadSchema,
  type QueueDraftMode,
  type RuntimeHelloCapabilities,
  type RuntimeSnapshot,
  type RuntimeSnapshotPatch,
  RuntimeSnapshotPatchSchema,
  RuntimeSnapshotSchema,
  type SessionApiResponse,
  SessionApiResponseSchema,
  type SessionRenameRequest,
  SessionRenameRequestSchema,
  type SessionSnapshotPatch,
  SessionSnapshotPatchSchema,
  type StartRuntimeRequest,
  StartRuntimeRequestSchema,
} from './schemas.js';
import {
  isRecord,
  nonEmptyString,
  onlyKeys,
  parseSchema,
  safeIdentifier,
  tryParseSchema,
} from './utils.js';

function validateImages(value: unknown): BridgeImageAttachment[] {
  if (value === undefined) return [];
  if (
    !Value.Check(
      Type.Array(BridgeImageAttachmentSchema, { maxItems: 4 }),
      value,
    )
  )
    throw new Error('Invalid image attachments.');
  const images = value as BridgeImageAttachment[];
  for (const image of images)
    if (!safeIdentifier(image.path, MAX_PATH))
      throw new Error('Invalid image attachment.');
  return images;
}

export function validateSessionName(value: unknown): string {
  if (!safeIdentifier(value, SESSION_NAME_MAX_LENGTH))
    throw new Error('Invalid session name.');
  return value.trim();
}

export function parseSessionRenameRequest(
  value: unknown,
): SessionRenameRequest {
  if (!Value.Check(SessionRenameRequestSchema, value))
    throw new Error('Invalid session rename request.');
  return { name: validateSessionName((value as SessionRenameRequest).name) };
}
export const tryParseSessionRenameRequest = (
  value: unknown,
): SessionRenameRequest | undefined => {
  try {
    return parseSessionRenameRequest(value);
  } catch {
    return undefined;
  }
};
export const validateSessionRenameRequest = parseSessionRenameRequest;

export function parseBridgeCommand(value: unknown): BridgeCommand {
  if (!Value.Check(BridgeCommandSchema, value))
    throw new Error('Invalid bridge command.');
  const command = value as BridgeCommand;
  if (
    command.type === 'queue.add' ||
    command.type === 'queueDraft.add' ||
    command.type === 'queue.update' ||
    command.type === 'queueDraft.update' ||
    command.type === 'queue.remove' ||
    command.type === 'queueDraft.remove'
  ) {
    const queueCommand = command as {
      clientId: string;
      text?: string;
      mode?: QueueDraftMode;
    };
    if (
      !onlyKeys(
        command as Record<string, unknown>,
        new Set(['id', 'type', 'clientId', 'mode', 'text']),
      ) ||
      !safeIdentifier(queueCommand.clientId, MAX_ID)
    )
      throw new Error('Invalid queue draft client id.');
    if (queueCommand.text !== undefined) {
      const text = queueCommand.text.trim();
      if (!text) throw new Error('Queue draft text is required.');
      return { ...command, text } as BridgeCommand;
    }
    return command;
  }
  if (
    command.type === 'prompt' ||
    command.type === 'steer' ||
    command.type === 'followUp'
  ) {
    if (
      !onlyKeys(
        command as Record<string, unknown>,
        new Set(['id', 'type', 'text', 'images']),
      )
    )
      throw new Error(`Invalid ${command.type} command.`);
    const text = command.text.trim();
    const images = validateImages(command.images);
    if (!text && images.length === 0)
      throw new Error('Command text or an image is required.');
    return { ...command, text, ...(images.length > 0 ? { images } : {}) };
  }
  if (command.type === 'setModel') {
    if (
      !safeIdentifier(command.provider, 200) ||
      !safeIdentifier(command.model, 300)
    )
      throw new Error('Invalid model selection.');
  }
  if (command.type === 'setThinking' && !safeIdentifier(command.level, 64))
    throw new Error('Invalid thinking level.');
  if (command.type === 'setSessionName') {
    if (
      !onlyKeys(
        command as Record<string, unknown>,
        new Set(['id', 'type', 'name']),
      )
    )
      throw new Error('Invalid session name command.');
    return { ...command, name: validateSessionName(command.name) };
  }
  if (
    (command.type === 'interaction.answer' ||
      command.type === 'interaction.cancel') &&
    !safeIdentifier(command.interactionId, 128)
  )
    throw new Error('Invalid interaction id.');
  if (command.type === 'action.invoke') {
    if (
      !onlyKeys(
        command as Record<string, unknown>,
        new Set(['id', 'type', 'actionId', 'input']),
      ) ||
      !safeIdentifier(command.actionId, MAX_ID)
    )
      throw new Error('Invalid semantic action invocation.');
  }
  return command;
}
export const validateBridgeCommand = parseBridgeCommand;
export const tryParseBridgeCommand = (
  value: unknown,
): BridgeCommand | undefined => {
  try {
    return parseBridgeCommand(value);
  } catch {
    return undefined;
  }
};

function validateRuntimeSnapshotCapabilities(
  snapshot: Pick<RuntimeSnapshot, 'capabilities'>,
): void {
  if (snapshot.capabilities !== undefined)
    parseExtensionCapabilitySnapshot(snapshot.capabilities);
}

function validateRuntimeSnapshotSurfaces(
  snapshot: Pick<RuntimeSnapshot, 'extensionSurfaces'>,
): void {
  if (snapshot.extensionSurfaces !== undefined)
    parseExtensionSurfaceList(snapshot.extensionSurfaces);
}

function validateHelloCapabilities(
  capabilities: RuntimeHelloCapabilities | undefined,
): void {
  if (!capabilities) return;
  if (capabilities.extensions)
    parseExtensionCapabilitySnapshot(capabilities.extensions);
  if (capabilities.extensionCapabilities)
    parseExtensionCapabilitySnapshot(capabilities.extensionCapabilities);
  if (
    capabilities.capabilitySummaries !== undefined ||
    capabilities.manifests !== undefined
  )
    parseExtensionCapabilitySnapshot({
      version: 1,
      capabilities: capabilities.capabilitySummaries ?? [],
      manifests: capabilities.manifests ?? [],
    });
}

/**
 * Validate capability snapshots after structural protocol validation. This is
 * kept separate from TypeBox because duplicate contribution IDs are semantic
 * invalidity, not a JSON-shape constraint.
 */
function validateBridgeEventCapabilities(event: BridgeEvent): void {
  if (event.type === 'runtime.hello') {
    validateRuntimeSnapshotCapabilities(event.snapshot);
    validateRuntimeSnapshotSurfaces(event.snapshot);
    validateHelloCapabilities(event.capabilities);
  } else if (
    (event.type === 'runtime.heartbeat' ||
      event.type === 'runtime.stateChanged') &&
    event.snapshot
  ) {
    validateRuntimeSnapshotCapabilities(event.snapshot);
    validateRuntimeSnapshotSurfaces(event.snapshot);
  }
}

export function parseBridgeEvent(value: unknown): BridgeEvent {
  const event = parseSchema(
    BridgeEventSchema,
    value,
    'bridge event',
  ) as unknown as BridgeEvent;
  validateBridgeEventCapabilities(event);
  return event;
}
export function tryParseBridgeEvent(value: unknown): BridgeEvent | undefined {
  try {
    return parseBridgeEvent(value);
  } catch {
    return undefined;
  }
}
export function isBridgeEvent(value: unknown): value is BridgeEvent {
  return tryParseBridgeEvent(value) !== undefined;
}

export function parseBridgeFrame(value: unknown): BridgeFrame {
  const frame = parseSchema(
    BridgeFrameSchema,
    value,
    'protocol frame',
  ) as unknown as BridgeFrame;
  if (frame.kind === 'event') validateBridgeEventCapabilities(frame.event);
  return frame;
}
export function tryParseBridgeFrame(value: unknown): BridgeFrame | undefined {
  try {
    return parseBridgeFrame(value);
  } catch {
    return undefined;
  }
}

function frameBytes(line: string | Uint8Array): number {
  return typeof line === 'string'
    ? new TextEncoder().encode(line).byteLength
    : line.byteLength;
}

export function parseFrame(line: string | Uint8Array): BridgeFrame {
  if (frameBytes(line) > MAX_FRAME_BYTES)
    throw new Error('Protocol frame exceeds size limit.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof line === 'string' ? line : new TextDecoder().decode(line),
    ) as unknown;
  } catch {
    throw new Error('Invalid protocol frame.');
  }
  return parseBridgeFrame(parsed);
}

export function serializeFrame(frame: unknown): string {
  const parsed = parseBridgeFrame(frame);
  const line = JSON.stringify(parsed);
  if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES)
    throw new Error('Protocol frame exceeds size limit.');
  return `${line}\n`;
}

export function parseStartRuntimeRequest(value: unknown): StartRuntimeRequest {
  if (!Value.Check(StartRuntimeRequestSchema, value)) {
    if (!isRecord(value) || !safeIdentifier(value.workspaceId, 256))
      throw new Error('workspaceId is required.');
    if (
      value.initialPrompt !== undefined &&
      !nonEmptyString(value.initialPrompt, 100_000)
    )
      throw new Error('Invalid initial prompt.');
    if (value.sessionId !== undefined && !safeIdentifier(value.sessionId, 256))
      throw new Error('Invalid sessionId.');
    if (value.name !== undefined && !safeIdentifier(value.name, 120))
      throw new Error('Invalid runtime name.');
    throw new Error('Invalid start runtime request.');
  }
  const input = value as StartRuntimeRequest;
  const result: StartRuntimeRequest = { workspaceId: input.workspaceId };
  if (input.sessionId !== undefined && !safeIdentifier(input.sessionId, 256))
    throw new Error('Invalid sessionId.');
  if (input.name !== undefined && !safeIdentifier(input.name, 120))
    throw new Error('Invalid runtime name.');
  if (
    input.initialPrompt !== undefined &&
    !nonEmptyString(input.initialPrompt, 100_000)
  )
    throw new Error('Invalid initial prompt.');
  if (input.sessionId) result.sessionId = input.sessionId;
  if (input.name) result.name = input.name;
  if (input.initialPrompt) result.initialPrompt = input.initialPrompt;
  if (input.acknowledgeSharedWorkingDirectory !== undefined)
    result.acknowledgeSharedWorkingDirectory =
      input.acknowledgeSharedWorkingDirectory;
  if (input.model) {
    if (
      !safeIdentifier(input.model.provider, 200) ||
      !safeIdentifier(input.model.model, 300)
    )
      throw new Error('Invalid model.');
    if (
      input.model.thinking !== undefined &&
      !safeIdentifier(input.model.thinking, 64)
    )
      throw new Error('Invalid thinking level.');
    result.model = {
      provider: input.model.provider,
      model: input.model.model,
      ...(input.model.thinking ? { thinking: input.model.thinking } : {}),
    };
  }
  return result;
}
export const validateStartRuntimeRequest = parseStartRuntimeRequest;
export const tryParseStartRuntimeRequest = (
  value: unknown,
): StartRuntimeRequest | undefined => {
  try {
    return parseStartRuntimeRequest(value);
  } catch {
    return undefined;
  }
};

export function parseNormalizedMessagePayload(
  value: unknown,
): NormalizedMessagePayload {
  return parseSchema(
    NormalizedMessagePayloadSchema,
    value,
    'normalized message payload',
  );
}
export function tryParseNormalizedMessagePayload(
  value: unknown,
): NormalizedMessagePayload | undefined {
  return tryParseSchema(NormalizedMessagePayloadSchema, value);
}
export function parseNormalizedToolPayload(
  value: unknown,
): NormalizedToolPayload {
  return parseSchema(
    NormalizedToolPayloadSchema,
    value,
    'normalized tool payload',
  );
}
export function tryParseNormalizedToolPayload(
  value: unknown,
): NormalizedToolPayload | undefined {
  return tryParseSchema(NormalizedToolPayloadSchema, value);
}
export function parseSessionSnapshotPatch(
  value: unknown,
): SessionSnapshotPatch {
  return parseSchema(
    SessionSnapshotPatchSchema,
    value,
    'session snapshot patch',
  );
}
export function tryParseSessionSnapshotPatch(
  value: unknown,
): SessionSnapshotPatch | undefined {
  return tryParseSchema(SessionSnapshotPatchSchema, value);
}
export function parseInteractionSnapshot(value: unknown): InteractionSnapshot {
  return parseSchema(InteractionSnapshotSchema, value, 'interaction');
}
export function tryParseInteractionSnapshot(
  value: unknown,
): InteractionSnapshot | undefined {
  return tryParseSchema(InteractionSnapshotSchema, value);
}
function validateBrowserSnapshotCapabilities(snapshot: BrowserSnapshot): void {
  for (const runtime of snapshot.runtimes)
    validateRuntimeSnapshotCapabilities(runtime);
}

function validateDashboardEventEnvelopeCapabilities(
  value: DashboardEventEnvelope,
): void {
  validateBridgeEventCapabilities(value.event);
  if (value.snapshot) validateBrowserSnapshotCapabilities(value.snapshot);
}

export function parseRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  const snapshot = parseSchema(
    RuntimeSnapshotSchema,
    value,
    'runtime snapshot',
  );
  validateRuntimeSnapshotCapabilities(snapshot);
  validateRuntimeSnapshotSurfaces(snapshot);
  return snapshot;
}
export function tryParseRuntimeSnapshot(
  value: unknown,
): RuntimeSnapshot | undefined {
  try {
    return parseRuntimeSnapshot(value);
  } catch {
    return undefined;
  }
}
export function parseRuntimeSnapshotPatch(
  value: unknown,
): RuntimeSnapshotPatch {
  const patch = parseSchema(
    RuntimeSnapshotPatchSchema,
    value,
    'runtime snapshot patch',
  );
  validateRuntimeSnapshotCapabilities(patch);
  validateRuntimeSnapshotSurfaces(patch);
  return patch;
}
export function tryParseRuntimeSnapshotPatch(
  value: unknown,
): RuntimeSnapshotPatch | undefined {
  try {
    return parseRuntimeSnapshotPatch(value);
  } catch {
    return undefined;
  }
}
export function parseDashboardEventEnvelope(
  value: unknown,
): DashboardEventEnvelope {
  const envelope = parseSchema(
    DashboardEventEnvelopeSchema,
    value,
    'dashboard event envelope',
  );
  validateDashboardEventEnvelopeCapabilities(envelope);
  return envelope;
}
export function tryParseDashboardEventEnvelope(
  value: unknown,
): DashboardEventEnvelope | undefined {
  try {
    return parseDashboardEventEnvelope(value);
  } catch {
    return undefined;
  }
}
export function parseDashboardStreamMessage(
  value: unknown,
): DashboardStreamMessage {
  const message = parseSchema(
    DashboardStreamMessageSchema,
    value,
    'dashboard stream message',
  );
  if ('event' in message) validateDashboardEventEnvelopeCapabilities(message);
  else validateBrowserSnapshotCapabilities(message.snapshot);
  return message;
}
export function tryParseDashboardStreamMessage(
  value: unknown,
): DashboardStreamMessage | undefined {
  try {
    return parseDashboardStreamMessage(value);
  } catch {
    return undefined;
  }
}
export function parseBrowserSnapshot(value: unknown): BrowserSnapshot {
  const snapshot = parseSchema(
    BrowserSnapshotSchema,
    value,
    'browser snapshot',
  );
  validateBrowserSnapshotCapabilities(snapshot);
  return snapshot;
}
export function tryParseBrowserSnapshot(
  value: unknown,
): BrowserSnapshot | undefined {
  try {
    return parseBrowserSnapshot(value);
  } catch {
    return undefined;
  }
}
export function parseDashboardMessage(value: unknown): DashboardMessage {
  const message = parseSchema(
    DashboardMessageSchema,
    value,
    'dashboard message',
  );
  if (message.type === 'snapshot')
    validateBrowserSnapshotCapabilities(message.snapshot);
  else {
    validateBridgeEventCapabilities(message.event);
    if (message.snapshot) validateBrowserSnapshotCapabilities(message.snapshot);
  }
  return message;
}
export function tryParseDashboardMessage(
  value: unknown,
): DashboardMessage | undefined {
  try {
    return parseDashboardMessage(value);
  } catch {
    return undefined;
  }
}
export function parseSessionApiResponse(value: unknown): SessionApiResponse {
  return parseSchema(SessionApiResponseSchema, value, 'session API response');
}
export function tryParseSessionApiResponse(
  value: unknown,
): SessionApiResponse | undefined {
  return tryParseSchema(SessionApiResponseSchema, value);
}
