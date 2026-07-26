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
const MAX_RELATIVE_COST = 1000;

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
  error?: string;
}

export interface DelegateCatalogRoute {
  route: string;
  provider?: string;
  model: string;
  thinking: ThinkingLevel;
  relativeCost: number;
  useFor: string;
  avoid: string;
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
    'useFor',
    'avoid',
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
        error: `delegate.modelCatalog.${route}.thinking must be one of: ${THINKING_LEVELS.join(', ')}.`,
      };
    const cost = record.relativeCost;
    if (
      typeof cost !== 'number' ||
      !Number.isFinite(cost) ||
      cost <= 0 ||
      cost > MAX_RELATIVE_COST
    )
      return {
        error: `delegate.modelCatalog.${route}.relativeCost must be a finite number greater than 0 and at most ${MAX_RELATIVE_COST}.`,
      };
    // Route selection is prose-driven: the orchestrator matches the task
    // against these, so a route without both is not selectable in practice.
    for (const field of ['useFor', 'avoid'] as const) {
      const text = record[field];
      if (typeof text !== 'string' || !text.trim())
        return {
          error: `delegate.modelCatalog.${route}.${field} must be non-empty text describing concrete task shapes.`,
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
    const provider =
      typeof record.provider === 'string' ? record.provider.trim() : undefined;
    catalog[route] = {
      model,
      thinking: record.thinking,
      relativeCost: cost,
      useFor: (record.useFor as string).trim().slice(0, 600),
      avoid: (record.avoid as string).trim().slice(0, 600),
      ...(provider ? { provider } : {}),
    };
  }
  return { catalog };
}

function defaultConfig(): DelegateConfig {
  return { ...DEFAULT_DELEGATE_RUNTIME };
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
  const config: DelegateConfig = {
    timeoutMs: timeout.value,
    maxParallelTasks: maxTasks.value,
    maxConcurrency: concurrency.value,
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

export function describeDelegateRouting(
  config: DelegateConfig,
): DelegateCatalogRoute[] {
  return (
    Object.entries(config.modelCatalog ?? {})
      .map(([route, entry]) => ({
        route,
        provider: entry.provider ?? config.provider,
        model: entry.model,
        thinking: entry.thinking,
        relativeCost: entry.relativeCost,
        useFor: entry.useFor,
        avoid: entry.avoid,
      }))
      // Cheapest first: the escalation ladder the orchestrator is told to climb.
      .sort(
        (left, right) =>
          left.relativeCost - right.relativeCost ||
          left.route.localeCompare(right.route),
      )
  );
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
        'Fresh delegate routing requires a route key from user-owned delegate.modelCatalog.',
    };
  const entry = config.modelCatalog?.[route];
  if (!entry)
    return {
      error: `Delegate route "${route}" is not in user-owned delegate.modelCatalog.`,
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
    },
  };
}
