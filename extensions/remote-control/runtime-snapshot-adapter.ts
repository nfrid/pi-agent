import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRuntimeCapabilitySnapshot } from '@pi-dashboard/extension-contributions';
import { deriveSessionTitle } from '../../packages/dashboard-protocol/src/dashboard-api';
import {
  type InteractionSnapshot,
  type RuntimeLiveState,
  type RuntimeSnapshot,
  redactImageData,
  type SessionSnapshot,
} from '../../packages/dashboard-protocol/src/pi-runtime-protocol';
import {
  activityGroupsCapabilitySnapshot,
  activityGroupsManifest,
} from '../activity-groups/contribution';
import type { InteractionBroker } from '../ask-user/broker';
import {
  ASK_USER_ANSWER_ACTION_ID,
  ASK_USER_CANCEL_ACTION_ID,
  askUserCapabilitySnapshot,
  askUserManifest,
} from '../ask-user/contribution';
import {
  delegateCapabilitySnapshot,
  delegateManifest,
} from '../delegate/contribution';
import { tasksCapabilitySnapshot, tasksManifest } from '../tasks/contribution';
import {
  remoteControlCapabilitySnapshot,
  remoteControlManifest,
} from './contribution';

const MAX_JSON_PAYLOAD_BYTES = 460_000;

export const CONTRIBUTION_MANIFESTS = [
  askUserManifest,
  activityGroupsManifest,
  remoteControlManifest,
  delegateManifest,
  tasksManifest,
] as const;
export const RUNTIME_CAPABILITIES = createRuntimeCapabilitySnapshot(
  CONTRIBUTION_MANIFESTS,
  [
    ...askUserCapabilitySnapshot.capabilities,
    ...activityGroupsCapabilitySnapshot.capabilities,
    ...remoteControlCapabilitySnapshot.capabilities,
    ...delegateCapabilitySnapshot.capabilities,
    ...tasksCapabilitySnapshot.capabilities,
  ],
);

export function jsonSafe(
  value: unknown,
  max = MAX_JSON_PAYLOAD_BYTES,
): unknown {
  try {
    const text = JSON.stringify(redactImageData(value));
    if (!text || Buffer.byteLength(text) > max) return null;
    return JSON.parse(text) as unknown;
  } catch {
    // Event schemas require the payload key to be present. Null is a valid,
    // bounded representation for an optional provider object that cannot be
    // cloned (for example, a cyclic or oversized value).
    return null;
  }
}

export function sessionSnapshot(ctx: ExtensionContext): SessionSnapshot {
  const manager = ctx.sessionManager;
  const entries = manager.getBranch() as readonly unknown[];
  const serialized = jsonSafe(entries);
  const complete = Array.isArray(serialized);
  return {
    id: manager.getSessionId(),
    file: manager.getSessionFile(),
    name: manager.getSessionName(),
    title: deriveSessionTitle(entries),
    cwd: manager.getCwd(),
    leafId: manager.getLeafId() ?? undefined,
    entriesComplete: complete,
    entries: complete ? serialized : [],
  };
}

export function modelSnapshot(ctx: ExtensionContext): RuntimeSnapshot['model'] {
  const model = ctx.model;
  if (!model) return undefined;
  return {
    provider: model.provider,
    model: model.id,
    thinking: ctx.thinkingLevel,
    supportsImages: model.input.includes('image'),
  };
}

export function modelCatalogSnapshot(
  ctx: ExtensionContext,
): RuntimeSnapshot['modelCatalog'] {
  const registry = (
    ctx as unknown as {
      modelRegistry?: {
        getAvailable?: () => readonly unknown[];
        hasConfiguredAuth?: (model: unknown) => boolean;
      };
      scopedModels?: readonly { model: unknown }[];
    }
  ).modelRegistry;
  const scopedModels = (
    ctx as unknown as {
      scopedModels?: readonly { model: unknown }[];
    }
  ).scopedModels;
  const models = (
    scopedModels && scopedModels.length > 0
      ? scopedModels.map(({ model }) => model)
      : (registry?.getAvailable?.() ?? [])
  ).filter((model) => registry?.hasConfiguredAuth?.(model) !== false);
  return models.slice(0, 256).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.provider !== 'string' || typeof value.id !== 'string')
      return [];
    const input = Array.isArray(value.input) ? value.input : [];
    return [
      {
        provider: value.provider,
        model: value.id,
        ...(typeof value.name === 'string' ? { name: value.name } : {}),
        supportsImages: input.includes('image'),
      },
    ];
  });
}

export function thinkingLevelsSnapshot(): string[] {
  // Keep this bounded wire data in sync with the installed Pi ThinkingLevel
  // union. `off` remains a dashboard control for disabling reasoning.
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
}

export function liveState(
  ctx: ExtensionContext,
  broker: InteractionBroker,
): RuntimeLiveState {
  if (broker.list().length > 0) return 'waiting';
  return ctx.isIdle() ? 'idle' : 'working';
}

function boundedText(value: unknown, max: number, fallback: string): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.slice(0, max) || fallback;
}

function boundedIdentifier(
  value: unknown,
  max: number,
  fallback: string,
): string {
  const text = Array.from(boundedText(value, max, fallback), (character) =>
    character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
      ? ''
      : character,
  ).join('');
  return text.slice(0, max) || fallback;
}

export function interactionSnapshot(
  interaction: ReturnType<InteractionBroker['list']>[number],
): InteractionSnapshot {
  // Normalize every field even when the JSON is otherwise small enough to fit
  // a frame. Frame-size checks do not enforce the stricter shared schema.
  return {
    id: boundedIdentifier(interaction.id, 256, 'interaction'),
    type: 'ask_user',
    question: boundedText(interaction.question, 20_000, 'Question'),
    choices: interaction.choices.slice(0, 50).map((choice, index) => ({
      label: boundedText(choice.label, 512, `Choice ${index + 1}`),
      value: boundedText(choice.value, 512, `choice-${index + 1}`),
      ...(typeof choice.description === 'string' && choice.description
        ? { description: choice.description.slice(0, 2_000) }
        : {}),
      ...(typeof choice.preview === 'string' && choice.preview
        ? { preview: choice.preview.slice(0, 4_000) }
        : {}),
      ...(typeof choice.custom === 'boolean' ? { custom: choice.custom } : {}),
    })),
    allowCustom: interaction.allowCustom === true,
    rendererId: 'ask-user.question',
    answerActionId: ASK_USER_ANSWER_ACTION_ID,
    cancelActionId: ASK_USER_CANCEL_ACTION_ID,
    viewModel: {
      id: boundedIdentifier(interaction.id, 256, 'interaction'),
      question: boundedText(interaction.question, 20_000, 'Question'),
      // The full descriptions/previews remain on the protocol snapshot. The
      // view model is intentionally compact so advertising it cannot double
      // a near-limit interaction frame.
      choices: interaction.choices.slice(0, 50).map((choice) => ({
        label: boundedText(choice.label, 512, 'Choice'),
        value: boundedText(choice.value, 512, 'choice'),
        ...(choice.custom === true ? { custom: true } : {}),
      })),
      allowCustom: interaction.allowCustom === true,
      ...(typeof interaction.customLabel === 'string' && interaction.customLabel
        ? { customLabel: interaction.customLabel.slice(0, 512) }
        : {}),
    },
    ...(typeof interaction.customLabel === 'string' && interaction.customLabel
      ? { customLabel: interaction.customLabel.slice(0, 512) }
      : {}),
    createdAt:
      typeof interaction.createdAt === 'number' &&
      Number.isFinite(interaction.createdAt)
        ? interaction.createdAt
        : 0,
  };
}
