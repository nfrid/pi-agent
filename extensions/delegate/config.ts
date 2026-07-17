import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
  DelegateModelCatalogEntry,
  DelegateRouteState,
  ThinkingLevel,
} from './types';

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
const SETTINGS_KEY = 'delegate';
const DEFAULT_MAX_RELATIVE_COST = 3;
const MAX_RELATIVE_METRIC = 1000;

export const DEFAULT_DELEGATE_RUNTIME = {
  timeoutMs: 10 * 60 * 1000,
  maxParallelTasks: 6,
  maxConcurrency: 3,
} as const;

const RUNTIME_LIMITS = {
  timeoutMs: { min: 10_000, max: 60 * 60 * 1000 },
  maxParallelTasks: { min: 1, max: 20 },
  maxConcurrency: { min: 1, max: 10 },
} as const;

export interface DelegateRuntimeConfig {
  timeoutMs: number;
  maxParallelTasks: number;
  maxConcurrency: number;
}

export interface DelegateConfig extends DelegateRuntimeConfig {
  provider?: string;
  modelCatalog?: Record<string, DelegateModelCatalogEntry>;
  maxRelativeCost: number;
  error?: string;
}

export interface DelegateCatalogRoute {
  route: string;
  provider?: string;
  model: string;
  thinking: ThinkingLevel;
  relativeCost: number;
  relativeIntelligence: number;
  description?: string;
  allowed: boolean;
}

function isThinking(value: unknown): value is ThinkingLevel {
  return (
    typeof value === 'string' &&
    THINKING_LEVELS.includes(value as ThinkingLevel)
  );
}

function parseModelCatalog(raw: unknown): {
  catalog?: Record<string, DelegateModelCatalogEntry>;
  error?: string;
} {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return {
      error: 'delegate.modelCatalog must be an object keyed by route label.',
    };
  const catalog: Record<string, DelegateModelCatalogEntry> = {};
  const pairs = new Map<string, string>();
  const routeLabels = new Set<string>();
  const allowedFields = new Set([
    'provider',
    'model',
    'thinking',
    'relativeCost',
    'relativeIntelligence',
    'description',
  ]);
  for (const [rawRoute, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const route = rawRoute.trim();
    if (!route || !value || typeof value !== 'object' || Array.isArray(value))
      return { error: `delegate.modelCatalog.${rawRoute} must be an object.` };
    const record = value as Record<string, unknown>;
    if (routeLabels.has(route))
      return {
        error: `delegate.modelCatalog route labels must remain unique after trimming: "${route}".`,
      };
    routeLabels.add(route);
    const unknownField = Object.keys(record).find(
      (field) => !allowedFields.has(field),
    );
    if (unknownField)
      return {
        error: `delegate.modelCatalog.${route}.${unknownField} is not supported.`,
      };
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model)
      return {
        error: `delegate.modelCatalog.${route}.model must be a non-empty model ID.`,
      };
    if (!isThinking(record.thinking))
      return {
        error: `delegate.modelCatalog.${route}.thinking must be one exact supported thinking level.`,
      };
    for (const metric of ['relativeCost', 'relativeIntelligence'] as const) {
      const metricValue = record[metric];
      if (
        typeof metricValue !== 'number' ||
        !Number.isFinite(metricValue) ||
        metricValue <= 0 ||
        metricValue > MAX_RELATIVE_METRIC
      )
        return {
          error: `delegate.modelCatalog.${route}.${metric} must be a finite number greater than 0 and at most ${MAX_RELATIVE_METRIC}.`,
        };
    }
    const pair = `${model}\0${record.thinking}`;
    const duplicate = pairs.get(pair);
    if (duplicate)
      return {
        error: `delegate.modelCatalog routes "${duplicate}" and "${route}" define the same model/thinking pair.`,
      };
    pairs.set(pair, route);
    if (
      record.provider !== undefined &&
      (typeof record.provider !== 'string' || !record.provider.trim())
    )
      return {
        error: `delegate.modelCatalog.${route}.provider must be a non-empty provider ID when provided.`,
      };
    if (
      record.description !== undefined &&
      (typeof record.description !== 'string' || !record.description.trim())
    )
      return {
        error: `delegate.modelCatalog.${route}.description must be non-empty text when provided.`,
      };
    const provider =
      typeof record.provider === 'string' ? record.provider.trim() : undefined;
    const description =
      typeof record.description === 'string'
        ? record.description.trim().slice(0, 500)
        : undefined;
    catalog[route] = {
      model,
      thinking: record.thinking,
      relativeCost: record.relativeCost as number,
      relativeIntelligence: record.relativeIntelligence as number,
      ...(provider ? { provider } : {}),
      ...(description ? { description } : {}),
    };
  }
  return { catalog };
}

function defaultConfig(): DelegateConfig {
  return {
    ...DEFAULT_DELEGATE_RUNTIME,
    maxRelativeCost: DEFAULT_MAX_RELATIVE_COST,
  };
}

function parseRuntimeSetting(
  record: Record<string, unknown>,
  key: keyof DelegateRuntimeConfig,
): { value: number; error?: string } {
  const raw = record[key];
  const fallback = DEFAULT_DELEGATE_RUNTIME[key];
  if (raw === undefined) return { value: fallback };
  const limits = RUNTIME_LIMITS[key];
  if (typeof raw !== 'number' || !Number.isInteger(raw))
    return {
      value: fallback,
      error: `delegate.${key} must be an integer between ${limits.min} and ${limits.max}.`,
    };
  if (raw < limits.min || raw > limits.max)
    return {
      value: Math.min(limits.max, Math.max(limits.min, raw)),
      error: `delegate.${key} must be between ${limits.min} and ${limits.max}; received ${raw}.`,
    };
  return { value: raw };
}

export function parseDelegateConfig(raw: unknown): DelegateConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return {
      ...defaultConfig(),
      error: 'delegate configuration must be an object.',
    };
  const record = raw as Record<string, unknown>;
  const allowedFields = new Set([
    'provider',
    'modelCatalog',
    'maxRelativeCost',
    'timeoutMs',
    'maxParallelTasks',
    'maxConcurrency',
  ]);
  const unknownField = Object.keys(record).find(
    (field) => !allowedFields.has(field),
  );
  const timeout = parseRuntimeSetting(record, 'timeoutMs');
  const maxTasks = parseRuntimeSetting(record, 'maxParallelTasks');
  const concurrency = parseRuntimeSetting(record, 'maxConcurrency');
  const parsedCatalog = parseModelCatalog(record.modelCatalog);
  const maxRelativeCost =
    record.maxRelativeCost === undefined
      ? DEFAULT_MAX_RELATIVE_COST
      : typeof record.maxRelativeCost === 'number' &&
          Number.isFinite(record.maxRelativeCost) &&
          record.maxRelativeCost > 0 &&
          record.maxRelativeCost <= MAX_RELATIVE_METRIC
        ? record.maxRelativeCost
        : DEFAULT_MAX_RELATIVE_COST;
  const config: DelegateConfig = {
    timeoutMs: timeout.value,
    maxParallelTasks: maxTasks.value,
    maxConcurrency: concurrency.value,
    maxRelativeCost,
  };
  const errors = [
    timeout.error,
    maxTasks.error,
    concurrency.error,
    unknownField ? `delegate.${unknownField} is not supported.` : undefined,
    record.provider !== undefined &&
    (typeof record.provider !== 'string' || !record.provider.trim())
      ? 'delegate.provider must be a non-empty provider ID when provided.'
      : undefined,
    parsedCatalog.error,
    record.maxRelativeCost !== undefined &&
    maxRelativeCost === DEFAULT_MAX_RELATIVE_COST &&
    record.maxRelativeCost !== DEFAULT_MAX_RELATIVE_COST
      ? `delegate.maxRelativeCost must be a finite number greater than 0 and at most ${MAX_RELATIVE_METRIC}.`
      : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  if (errors) config.error = errors;
  if (typeof record.provider === 'string' && record.provider.trim())
    config.provider = record.provider.trim();
  if (parsedCatalog.catalog) config.modelCatalog = parsedCatalog.catalog;
  return config;
}

function readConfigFile(settingsPath: string): DelegateConfig {
  if (!existsSync(settingsPath)) return defaultConfig();
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const nested = raw[SETTINGS_KEY];
    if (nested === undefined) return defaultConfig();
    return parseDelegateConfig(nested);
  } catch {
    return {
      ...defaultConfig(),
      error: `Could not parse delegate configuration at ${settingsPath}.`,
    };
  }
}

export function loadDelegateConfig(_cwd: string): DelegateConfig {
  // Model routing is user-owned. Do not let a repository silently choose which
  // subscription/provider delegated work consumes.
  return readConfigFile(path.join(getAgentDir(), 'settings.json'));
}

export function describeDelegateRouting(config: DelegateConfig): {
  maxRelativeCost: number;
  catalog: DelegateCatalogRoute[];
} {
  const catalog = Object.entries(config.modelCatalog ?? {})
    .map(([route, entry]) => ({
      route,
      provider: entry.provider ?? config.provider,
      model: entry.model,
      thinking: entry.thinking,
      relativeCost: entry.relativeCost,
      relativeIntelligence: entry.relativeIntelligence,
      description: entry.description,
      allowed: entry.relativeCost <= config.maxRelativeCost,
    }))
    .sort(
      (left, right) =>
        left.relativeCost - right.relativeCost ||
        right.relativeIntelligence - left.relativeIntelligence ||
        left.route.localeCompare(right.route),
    );
  return { maxRelativeCost: config.maxRelativeCost, catalog };
}

export function resolveDelegateRoute(
  requested: unknown,
  config: DelegateConfig,
): { routing?: DelegateRouteState; error?: string } {
  if (config.error) return { error: config.error };
  const route = typeof requested === 'string' ? requested.trim() : '';
  if (!route)
    return {
      error:
        'Fresh delegate routing requires one exact route from user-owned delegate.modelCatalog.',
    };
  const entry = config.modelCatalog?.[route];
  if (!entry)
    return {
      error: `Delegate route "${route}" is not in user-owned delegate.modelCatalog.`,
    };
  if (entry.relativeCost > config.maxRelativeCost)
    return {
      error: `Delegate route "${route}" relative cost ${entry.relativeCost} exceeds user-owned maximum ${config.maxRelativeCost}.`,
    };
  const provider = entry.provider ?? config.provider;
  if (!provider)
    return {
      error: `Delegate route "${route}" has no provider. Configure delegate.provider or modelCatalog.${route}.provider.`,
    };
  return {
    routing: {
      route,
      provider,
      model: entry.model,
      thinking: entry.thinking,
      relativeCost: entry.relativeCost,
      relativeIntelligence: entry.relativeIntelligence,
    },
  };
}
