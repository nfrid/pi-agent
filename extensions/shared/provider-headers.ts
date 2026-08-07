import type { ProviderHeaders } from '@earendil-works/pi-ai';

/** Convert Pi provider headers to headers accepted by ordinary fetch(). */
export function fetchHeaders(
  headers: ProviderHeaders | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
}
