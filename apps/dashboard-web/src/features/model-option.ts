import type { ModelSelection, RuntimeSnapshot } from '@pi-dashboard/protocol';

export type RuntimeModelOption = NonNullable<
  RuntimeSnapshot['modelCatalog']
>[number];

const FULL_CATALOG_BOUND = 256;
export const draftRuntimeOptionsStorageKey =
  'pi-dashboard-draft-runtime-options:v1';
const THINKING_LEVEL_BOUND = 16;

type DraftRuntimeOptions = {
  models: readonly RuntimeModelOption[];
  thinkingLevels: readonly string[];
};

function validCachedModel(value: unknown): value is RuntimeModelOption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  if (
    Object.keys(model).some(
      (key) =>
        key !== 'provider' &&
        key !== 'model' &&
        key !== 'name' &&
        key !== 'contextWindow' &&
        key !== 'supportsImages',
    )
  )
    return false;
  return (
    typeof model.provider === 'string' &&
    model.provider.length > 0 &&
    model.provider.length <= 200 &&
    typeof model.model === 'string' &&
    model.model.length > 0 &&
    model.model.length <= 300 &&
    (model.name === undefined ||
      (typeof model.name === 'string' &&
        model.name.length > 0 &&
        model.name.length <= 300)) &&
    (model.contextWindow === undefined ||
      (typeof model.contextWindow === 'number' &&
        Number.isFinite(model.contextWindow) &&
        model.contextWindow >= 1)) &&
    (model.supportsImages === undefined ||
      typeof model.supportsImages === 'boolean')
  );
}

function readDraftRuntimeOptions(): DraftRuntimeOptions {
  try {
    const raw = globalThis.localStorage?.getItem(draftRuntimeOptionsStorageKey);
    if (!raw) return { models: [], thinkingLevels: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { models: [], thinkingLevels: [] };
    const value = parsed as Record<string, unknown>;
    const models = Array.isArray(value.models)
      ? value.models.filter(validCachedModel).slice(0, FULL_CATALOG_BOUND)
      : [];
    const thinkingLevels = Array.isArray(value.thinkingLevels)
      ? value.thinkingLevels
          .filter(
            (level): level is string =>
              typeof level === 'string' &&
              level.length > 0 &&
              level.length <= 64,
          )
          .slice(0, THINKING_LEVEL_BOUND)
      : [];
    return { models, thinkingLevels };
  } catch {
    return { models: [], thinkingLevels: [] };
  }
}

function writeDraftRuntimeOptions(options: DraftRuntimeOptions): void {
  try {
    globalThis.localStorage?.setItem(
      draftRuntimeOptionsStorageKey,
      JSON.stringify({
        models: options.models.slice(0, FULL_CATALOG_BOUND),
        thinkingLevels: options.thinkingLevels.slice(0, THINKING_LEVEL_BOUND),
      }),
    );
  } catch {
    // Browser storage is best effort.
  }
}

export function rememberDraftRuntimeOptions(
  runtimes: readonly RuntimeSnapshot[],
): void {
  const current = readDraftRuntimeOptions();
  const models = configuredModelOptions(runtimes).filter(validCachedModel);
  const thinkingLevels = [
    ...new Set(runtimes.flatMap((runtime) => runtime.thinkingLevels ?? [])),
  ].filter(
    (level): level is string =>
      typeof level === 'string' && level.length > 0 && level.length <= 64,
  );
  writeDraftRuntimeOptions({
    models: models.length > 0 ? models : current.models,
    thinkingLevels:
      thinkingLevels.length > 0 ? thinkingLevels : current.thinkingLevels,
  });
}

export function draftRuntimeOptions(
  runtimes: readonly RuntimeSnapshot[],
): DraftRuntimeOptions {
  const cached = readDraftRuntimeOptions();
  const models = configuredModelOptions(runtimes);
  const thinkingLevels = [
    ...new Set(runtimes.flatMap((runtime) => runtime.thinkingLevels ?? [])),
  ];
  return {
    models: models.length > 0 ? models : cached.models,
    thinkingLevels:
      thinkingLevels.length > 0 ? thinkingLevels : cached.thinkingLevels,
  };
}

function withCurrentModel(
  options: readonly RuntimeModelOption[],
  runtime: RuntimeSnapshot | undefined,
): readonly RuntimeModelOption[] {
  if (!runtime?.model) return options;
  const currentValue = modelOptionValue(
    runtime.model.provider,
    runtime.model.model,
  );
  if (
    options.some(
      (option) =>
        modelOptionValue(option.provider, option.model) === currentValue,
    )
  )
    return options;
  return [
    {
      provider: runtime.model.provider,
      model: runtime.model.model,
      supportsImages: runtime.model.supportsImages,
    },
    ...options,
  ];
}

export function configuredModelOptions(
  runtimes: readonly RuntimeSnapshot[],
  preferred?: RuntimeSnapshot,
): readonly RuntimeModelOption[] {
  const runtimeCatalogs = runtimes
    .map((runtime) => ({ runtime, catalog: runtime.modelCatalog ?? [] }))
    .filter(({ catalog }) => catalog.length > 0);
  const catalogs = runtimeCatalogs.map(({ catalog }) => catalog);
  if (!preferred) {
    const configured = catalogs.filter(
      (catalog) => catalog.length < FULL_CATALOG_BOUND,
    );
    const options = new Map<string, RuntimeModelOption>();
    const selected = configured;
    for (const catalog of selected)
      for (const model of catalog)
        options.set(modelOptionValue(model.provider, model.model), model);
    return [...options.values()];
  }
  const own = preferred.modelCatalog ?? [];
  if (own.length > 0 && own.length < FULL_CATALOG_BOUND)
    return withCurrentModel(own, preferred);
  const currentValue = preferred.model
    ? modelOptionValue(preferred.model.provider, preferred.model.model)
    : undefined;
  const compatibleCatalogs = runtimeCatalogs
    .filter(
      ({ runtime, catalog }) =>
        runtime !== preferred &&
        typeof preferred.cwd === 'string' &&
        runtime.cwd === preferred.cwd &&
        catalog.length < FULL_CATALOG_BOUND &&
        Boolean(
          currentValue &&
            catalog.some(
              (model) =>
                modelOptionValue(model.provider, model.model) === currentValue,
            ),
        ),
    )
    .sort((left, right) => left.catalog.length - right.catalog.length);
  const compatible = compatibleCatalogs[0]?.catalog;
  // Connected runtimes share Pi's configured registry. Anything else
  // fails closed to the current model rather than exposing foreign choices.
  return withCurrentModel(compatible ?? [], preferred);
}

export function draftModelSelection(
  runtimes: readonly RuntimeSnapshot[],
  selected?: ModelSelection,
  configuredDefault?: ModelSelection,
): ModelSelection | undefined {
  const models = draftRuntimeOptions(runtimes).models;
  const available = new Set(
    models.map((model) => modelOptionValue(model.provider, model.model)),
  );
  if (selected?.thinking) return selected;
  if (configuredDefault?.thinking) return configuredDefault;
  const current = runtimes.find(
    (runtime) =>
      runtime.model &&
      available.has(
        modelOptionValue(runtime.model.provider, runtime.model.model),
      ),
  )?.model;
  if (current)
    return {
      provider: current.provider,
      model: current.model,
      ...(current.thinking ? { thinking: current.thinking } : {}),
    };
  if (selected) return selected;
  if (configuredDefault) return configuredDefault;
  const first = models[0];
  return first ? { provider: first.provider, model: first.model } : undefined;
}

export function modelOptionValue(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
}

export function parseModelOptionValue(
  value: string,
): { provider: string; model: string } | undefined {
  const separator = value.indexOf('/');
  if (separator < 1 || separator === value.length - 1) return undefined;
  try {
    const provider = decodeURIComponent(value.slice(0, separator));
    const model = decodeURIComponent(value.slice(separator + 1));
    return provider && model ? { provider, model } : undefined;
  } catch {
    return undefined;
  }
}
