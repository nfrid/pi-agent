import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export type PiModel = NonNullable<ExtensionContext['model']>;

export type UsageWindow = {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
};

export type UsageSnapshot = {
  limitId: string;
  limitName?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
};

export type UsageReport = { capturedAt: number; snapshots: UsageSnapshot[] };

export type BackendPayload = {
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
};

export type AppServerResponse = {
  rateLimits?: unknown;
  rateLimitsByLimitId?: unknown;
};

export type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
};

export type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
