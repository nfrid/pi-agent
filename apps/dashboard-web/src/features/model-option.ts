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
