import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  type AutonomyConfig,
  type AutonomyMode,
  type AutonomyProfile,
  type AutonomyProfileName,
  CAPABILITIES,
  type Capability,
} from './types';

export const AUTONOMY_PROFILES: Record<AutonomyProfileName, AutonomyProfile> = {
  cautious: {
    name: 'cautious',
    confirmReversibleChoices: true,
    scheduler: {
      maxChildren: 2,
      maxConcurrency: 1,
      maxDurationMs: 5 * 60_000,
      maxTurns: 8,
      maxComputeUnits: 24,
      targetOutputTokens: 12_000,
      targetCostUsd: 2,
    },
  },
  standard: {
    name: 'standard',
    confirmReversibleChoices: false,
    scheduler: {
      maxChildren: 4,
      maxConcurrency: 2,
      maxDurationMs: 10 * 60_000,
      maxTurns: 16,
      maxComputeUnits: 48,
      targetOutputTokens: 24_000,
      targetCostUsd: 5,
    },
  },
  high: {
    name: 'high',
    confirmReversibleChoices: false,
    scheduler: {
      maxChildren: 6,
      maxConcurrency: 3,
      maxDurationMs: 15 * 60_000,
      maxTurns: 24,
      maxComputeUnits: 96,
      targetOutputTokens: 40_000,
      targetCostUsd: 10,
    },
  },
};

function profileName(value: unknown): AutonomyProfileName | undefined {
  return value === 'cautious' || value === 'standard' || value === 'high'
    ? value
    : undefined;
}

function autonomyMode(value: unknown): AutonomyMode | undefined {
  return value === 'observe' || value === 'canary' || value === 'enforce'
    ? value
    : undefined;
}

export function parseCapabilities(value: unknown): Capability[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [
    ...new Set(
      values
        .map((item) => String(item).trim())
        .filter((item): item is Capability =>
          CAPABILITIES.includes(item as Capability),
        ),
    ),
  ];
}

export function parseScope(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [
    ...new Set(values.map((item) => String(item).trim()).filter(Boolean)),
  ];
}

export function parseAutonomyConfig(raw: unknown): AutonomyConfig {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const mode = autonomyMode(record.mode) ?? 'observe';
  return {
    profile:
      record.profile === undefined
        ? 'standard'
        : (profileName(record.profile) ?? 'cautious'),
    mode,
    capabilities: parseCapabilities(record.capabilities),
    scope: parseScope(record.scope),
    trustedRoots: parseScope(record.trustedRoots),
    autoApprove: parseCapabilities(record.autoApprove).filter(
      (capability) => capability === 'inspect' || capability === 'edit',
    ),
  };
}

export function loadAutonomyConfig(): AutonomyConfig {
  const settingsPath = path.join(getAgentDir(), 'settings.json');
  if (!existsSync(settingsPath)) return parseAutonomyConfig(undefined);
  try {
    const root = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<
      string,
      unknown
    >;
    return parseAutonomyConfig(root.autonomy);
  } catch {
    return parseAutonomyConfig(undefined);
  }
}

export function resolveProfile(name: unknown): AutonomyProfile {
  return AUTONOMY_PROFILES[
    name === undefined ? 'standard' : (profileName(name) ?? 'cautious')
  ];
}
