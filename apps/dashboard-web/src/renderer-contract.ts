import type {
  ExtensionSurfacePlacement,
  RendererDescriptor,
} from '@pi-dashboard/extension-contributions';
import type { ReactNode } from 'react';

export interface DashboardRendererContext {
  readonly surfaceId?: string;
  readonly rendererId?: string;
  readonly placement?: ExtensionSurfacePlacement;
  /** Freeze live elapsed-time renderers at the reached pause boundary. */
  readonly pausedAt?: number;
}

export interface DashboardRenderer {
  readonly descriptor: RendererDescriptor;
  readonly render: (
    input: unknown,
    context?: DashboardRendererContext,
  ) => ReactNode;
}
