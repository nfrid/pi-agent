import { timingSafeEqual } from 'node:crypto';

export function safeTokenEqual(
  actual: string | undefined,
  expected: string,
): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function allowedOrigin(
  origin: string | undefined,
  configured: readonly string[],
): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password) return false;
    return configured.some((candidate) => candidate === origin);
  } catch {
    return false;
  }
}

export function isStateChangingMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

export function authorizeRequest(input: {
  method: string;
  origin?: string;
  authorization?: string;
  tokenHeader?: string;
  /** Only the external machine route may bypass Origin with Bearer auth. */
  allowOriginlessBearer?: boolean;
  expectedToken: string;
  allowedOrigins: readonly string[];
}): { ok: true } | { ok: false; status: number; error: string } {
  if (input.origin && !allowedOrigin(input.origin, input.allowedOrigins))
    return { ok: false, status: 403, error: 'Origin is not allowed.' };
  const bearer = input.authorization?.startsWith('Bearer ')
    ? input.authorization.slice(7)
    : undefined;
  // Browsers omit Origin on same-origin GET and HEAD requests. Only the
  // external machine route may use originless Bearer authentication.
  if (isStateChangingMethod(input.method) && !input.origin) {
    if (!input.allowOriginlessBearer || bearer === undefined)
      return { ok: false, status: 403, error: 'Origin is required.' };
    if (input.tokenHeader !== undefined)
      return {
        ok: false,
        status: 403,
        error: 'Bearer authentication required.',
      };
  }
  const token = input.tokenHeader ?? bearer;
  if (!safeTokenEqual(token, input.expectedToken))
    return { ok: false, status: 401, error: 'Authentication required.' };
  return { ok: true };
}

export function sanitizeDisplayName(
  value: string | undefined,
  fallback = 'pi-agent',
): string {
  const normalized = (value ?? fallback)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\p{Sc}._ -]+/gu, '-')
    .trim();
  return [...normalized].slice(0, 64).join('') || fallback;
}
