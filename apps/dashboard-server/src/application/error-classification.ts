export const DASHBOARD_DOMAIN_CODES = [
  'active-session',
  'merge-conflict',
  'restart-precondition',
  'idempotency-conflict',
  'active-writer',
  'sqlite-constraint',
  'orchestration-conflict',
  'session-assigned',
  'session-link-conflict',
  'unknown-workspace',
  'stale-history-cursor',
  'protocol-mismatch',
] as const;

export type DashboardDomainCode = (typeof DASHBOARD_DOMAIN_CODES)[number];

export interface DashboardErrorClassification {
  code?: DashboardDomainCode;
  /** A caller-safe message; database details are always replaced. */
  message?: string;
}

const domainCodes = new Set<string>(DASHBOARD_DOMAIN_CODES);
const databaseDetailPattern =
  /sqlite|unique constraint|constraint failed|database is locked|no such table|malformed database/i;

function messageOf(value: unknown): string | undefined {
  if (value instanceof Error && value.message.length > 0) return value.message;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    const message = (value as { message: string }).message;
    return message.length > 0 ? message : undefined;
  }
  return undefined;
}

/** Classify nested adapter errors without importing an HTTP or RPC type. */
export function classifyDashboardError(
  error: unknown,
): DashboardErrorClassification {
  let current: unknown = error;
  let code: DashboardDomainCode | undefined;
  let hasDatabaseDetail = false;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === 'object' || typeof current === 'function') {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const explicit = (current as { code?: unknown }).code;
    if (!code && typeof explicit === 'string' && domainCodes.has(explicit))
      code = explicit as DashboardDomainCode;
    const message = messageOf(current);
    if (message && databaseDetailPattern.test(message))
      hasDatabaseDetail = true;
    if (
      !code &&
      message &&
      /^(?:stale|invalid) history cursor\.?$/iu.test(message)
    )
      code = 'stale-history-cursor';
    current = (current as { cause?: unknown }).cause;
  }
  if (!code && hasDatabaseDetail) code = 'sqlite-constraint';
  const databaseConflict =
    hasDatabaseDetail ||
    code === 'active-writer' ||
    code === 'sqlite-constraint';
  const message = databaseConflict
    ? 'The orchestration request conflicts with existing state.'
    : error instanceof Error
      ? messageOf(error)
      : undefined;
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}
