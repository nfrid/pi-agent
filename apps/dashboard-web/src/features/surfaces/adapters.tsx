import {
  DELEGATE_RENDERER_ID,
  type ExtensionSurface,
  TASKS_RENDERER_ID,
} from '@pi-dashboard/extension-contributions';
import type { ReactNode } from 'react';
import type { DashboardRendererContext } from '../../renderer-contract';
import { DelegateSurface } from './delegate-surface';
import { TasksSurface } from './tasks-surface';

function surfaceForRenderer(
  input: unknown,
  context: DashboardRendererContext | undefined,
  rendererId: string,
): ExtensionSurface {
  return {
    id: context?.surfaceId ?? rendererId,
    rendererId: context?.rendererId ?? rendererId,
    ...(context?.placement === undefined
      ? {}
      : { placement: context.placement }),
    viewModel: input,
  };
}

export function renderDelegateSurface(
  input: unknown,
  context?: DashboardRendererContext,
): ReactNode {
  return (
    <DelegateSurface
      surface={surfaceForRenderer(input, context, DELEGATE_RENDERER_ID)}
      pausedAt={context?.pausedAt}
    />
  );
}

export function renderTasksSurface(
  input: unknown,
  context?: DashboardRendererContext,
): ReactNode {
  return (
    <TasksSurface
      surface={surfaceForRenderer(input, context, TASKS_RENDERER_ID)}
      paused={context?.pausedAt !== undefined}
    />
  );
}
