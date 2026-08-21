import type { RuntimeSnapshot } from '@pi-dashboard/protocol';

export type RuntimeModelOption = NonNullable<
  RuntimeSnapshot['modelCatalog']
>[number];

const FULL_CATALOG_BOUND = 256;

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
