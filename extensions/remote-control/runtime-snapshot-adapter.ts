import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  DASHBOARD_SUPPORTED_BUILTIN_COMMANDS,
  deriveSessionTitle,
  MAX_COMPOSER_COMMAND_ARGUMENT_HINT,
  MAX_COMPOSER_COMMAND_DESCRIPTION,
  MAX_COMPOSER_COMMAND_NAME,
  MAX_COMPOSER_COMMANDS,
} from '@pi-dashboard/protocol/dashboard-api';
import type {
  ComposerCommandEntry,
  RuntimeLiveState,
  RuntimeSnapshot,
  SessionSnapshot,
} from '@pi-dashboard/protocol/pi-runtime-protocol';
import {
  aggregateRuntimeCapabilities,
  contributionManifests,
} from '../shared/runtime/capability-registry';
import type { SessionScopeId } from '../shared/runtime/scoped-services';
import { jsonSafe } from './json-safe';

export { jsonSafe } from './json-safe';

/** Aggregate contribution manifests from the session capability registry. */
export function getContributionManifests(scopeId?: SessionScopeId) {
  return contributionManifests(scopeId);
}

/** Aggregate runtime capabilities from the session capability registry. */
export function getRuntimeCapabilities(scopeId?: SessionScopeId) {
  return aggregateRuntimeCapabilities(scopeId);
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

function cleanCatalogueText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = Array.from(value, (character) =>
    character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
      ? ''
      : character,
  )
    .join('')
    .trim()
    .slice(0, max);
  return text || undefined;
}

function cleanComposerCommand(
  value: unknown,
  source: ComposerCommandEntry['source'],
): ComposerCommandEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || !/^[^\s/]+$/u.test(candidate.name))
    return undefined;
  let name = cleanCatalogueText(candidate.name, MAX_COMPOSER_COMMAND_NAME);
  if (!name) return undefined;
  if (source === 'skill' && !name.startsWith('skill:')) name = `skill:${name}`;
  name = name.slice(0, MAX_COMPOSER_COMMAND_NAME);
  if (!name || !/^[^\s/]+$/u.test(name)) return undefined;
  const description = cleanCatalogueText(
    candidate.description,
    MAX_COMPOSER_COMMAND_DESCRIPTION,
  );
  const argumentHint = cleanCatalogueText(
    candidate.argumentHint,
    MAX_COMPOSER_COMMAND_ARGUMENT_HINT,
  );
  return {
    name,
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    source,
  };
}

/** Project only dashboard-safe Pi resources; extension commands are executable-only. */
export function composerCommandsSnapshot(
  pi: ExtensionAPI,
): readonly ComposerCommandEntry[] {
  const commands: ComposerCommandEntry[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, source: ComposerCommandEntry['source']) => {
    const command = cleanComposerCommand(value, source);
    if (!command || seen.has(command.name)) return;
    seen.add(command.name);
    commands.push(command);
  };
  for (const command of DASHBOARD_SUPPORTED_BUILTIN_COMMANDS)
    add(command, 'builtin');
  try {
    const getCommands = (
      pi as unknown as { getCommands?: () => readonly unknown[] }
    ).getCommands;
    for (const command of getCommands?.() ?? []) {
      if (!command || typeof command !== 'object') continue;
      const source = (command as { source?: unknown }).source;
      if (source === 'prompt' || source === 'skill') add(command, source);
      if (commands.length >= MAX_COMPOSER_COMMANDS) break;
    }
  } catch {
    // Command discovery is optional; builtins remain available when Pi is still starting.
  }
  return commands;
}

export function liveState(ctx: ExtensionContext): RuntimeLiveState {
  return ctx.isIdle() ? 'idle' : 'working';
}
