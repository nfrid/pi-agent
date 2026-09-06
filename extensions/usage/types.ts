import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export type {
  UsageReport,
  UsageSnapshot,
  UsageWindow,
} from '@pi-dashboard/protocol';

export type PiModel = NonNullable<ExtensionContext['model']>;
