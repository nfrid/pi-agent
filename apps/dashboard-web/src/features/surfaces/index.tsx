import type { ExtensionSurface } from '@pi-dashboard/extension-contributions';
import type { ReactNode } from 'react';
import type { DashboardRendererContext } from '../../renderer-registry';
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
      surface={surfaceForRenderer(input, context, 'delegate.status')}
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
      surface={surfaceForRenderer(input, context, 'tasks.current')}
      paused={context?.pausedAt !== undefined}
    />
  );
}

export {
  DelegateSurface,
  delegateActivityLabel,
  delegateReferenceLabel,
  delegateRowActivityLabel,
  humanizeDelegateLogicalId,
  selectedDelegateInspectionRow,
} from './delegate-surface';
