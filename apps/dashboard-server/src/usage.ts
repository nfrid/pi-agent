export interface UsageProvider {
  get(signal?: AbortSignal): Promise<unknown>;
}

export class CodexUsageProvider implements UsageProvider {
  constructor(
    private readonly url = process.env.PI_DASHBOARD_CODEX_USAGE_URL ??
      'https://chatgpt.com/backend-api/wham/usage',
  ) {}
  async get(signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'pi-dashboard',
    };
    if (process.env.PI_DASHBOARD_CODEX_AUTH)
      headers.Authorization = `Bearer ${process.env.PI_DASHBOARD_CODEX_AUTH}`;
    const response = await fetch(this.url, { headers, signal });
    if (!response.ok)
      throw new Error(`Codex usage returned ${response.status}.`);
    const value: unknown = await response.json();
    return { capturedAt: Date.now(), ...normalizeUsage(value) };
  }
}

export function normalizeUsage(value: unknown): { snapshots: unknown[] } {
  if (!value || typeof value !== 'object') return { snapshots: [] };
  const record = value as Record<string, unknown>;
  const limits = record.rate_limit ?? record.rateLimits ?? record.rate_limits;
  if (!limits || typeof limits !== 'object') return { snapshots: [] };
  const snapshots: unknown[] = [];
  for (const [limitId, raw] of Object.entries(
    limits as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    snapshots.push({
      limitId,
      limitName: item.name,
      primary: item.primary_window ?? item.primary,
      secondary: item.secondary_window ?? item.secondary,
    });
  }
  return { snapshots };
}
