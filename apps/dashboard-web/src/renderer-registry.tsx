import {
  type ExtensionSurfacePlacement,
  isTypeBoxSchema,
  type RendererDescriptor,
} from '@pi-dashboard/extension-contributions';
import type { ReactNode } from 'react';
import { Value } from 'typebox/value';
import { activityGroupsRenderer } from '../../../extensions/activity-groups/contribution';
import { askUserRenderer } from '../../../extensions/ask-user/contribution';
import { delegateStatusRenderer } from '../../../extensions/delegate/contribution';
import {
  type PauseStatusViewModel,
  pauseStatusRenderer,
} from '../../../extensions/pause/contribution';
import { tasksRenderer } from '../../../extensions/tasks/contribution';
import { renderDelegateSurface, renderTasksSurface } from './features/surfaces';

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

export function createDashboardRendererRegistry(
  renderers: readonly DashboardRenderer[],
): ReadonlyMap<string, DashboardRenderer> {
  const result = new Map<string, DashboardRenderer>();
  for (const renderer of renderers) {
    if (!isTypeBoxSchema(renderer.descriptor.inputSchema))
      throw new Error(
        `Renderer ${renderer.descriptor.id} has no valid schema.`,
      );
    if (result.has(renderer.descriptor.id))
      throw new Error(
        `Duplicate dashboard renderer ID: ${renderer.descriptor.id}`,
      );
    result.set(renderer.descriptor.id, renderer);
  }
  return result;
}

export function genericUnknownRenderer(
  input: unknown,
  rendererId?: string,
): ReactNode {
  let text = '[unavailable renderer data]';
  try {
    text = JSON.stringify(input, null, 2) ?? text;
  } catch {
    // An opaque provider object is not allowed to break the dashboard.
  }
  return (
    <details className="contribution-fallback">
      <summary>
        {rendererId
          ? `Unsupported renderer: ${rendererId}`
          : 'Unsupported extension content'}
      </summary>
      <pre>{text}</pre>
    </details>
  );
}

const explicitRenderers: readonly DashboardRenderer[] = [
  {
    descriptor: askUserRenderer,
    render: (input) => {
      const value = input as {
        question?: unknown;
        choices?: unknown;
        allowCustom?: unknown;
        customLabel?: unknown;
      };
      const choices = Array.isArray(value.choices)
        ? value.choices.filter(
            (choice): choice is string =>
              typeof choice === 'string' && choice.trim().length > 0,
          )
        : [];
      return (
        <div className="ask-user-renderer">
          <p>
            {typeof value.question === 'string'
              ? value.question
              : 'Question unavailable.'}
          </p>
          {choices.length > 0 ? (
            <ul className="ask-user-choices" aria-label="Suggested answers">
              {choices.slice(0, 6).map((choice) => (
                <li key={choice}>
                  <span className="ask-user-choice">{choice}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {value.allowCustom === true ? (
            <small className="ask-user-custom">
              {typeof value.customLabel === 'string' && value.customLabel.trim()
                ? value.customLabel
                : 'Custom answer allowed'}
            </small>
          ) : null}
        </div>
      );
    },
  },
  {
    descriptor: activityGroupsRenderer,
    render: (input) => {
      const value = input as {
        title?: unknown;
        status?: unknown;
        toolCount?: unknown;
      };
      const status =
        typeof value.status === 'string' ? value.status : 'unknown';
      const statusClass =
        status === 'ended-error'
          ? 'activity-ended-error'
          : status === 'live' || status === 'preparing'
            ? 'activity-pending'
            : 'activity-settled';
      const icon =
        status === 'ended-error' ? '!' : status === 'settled' ? '•' : '…';
      return (
        <div className={`activity-renderer-chip ${statusClass}`}>
          <span className="activity-icon" aria-hidden="true">
            {icon}
          </span>
          <strong>
            {typeof value.title === 'string' ? value.title : 'Activity group'}
          </strong>
          <small>{String(value.toolCount ?? 0)} tools</small>
        </div>
      );
    },
  },
  // Live extension renderers are explicit trusted imports. Their IDs are
  // matched exactly and their descriptors validate input before adapters run.
  {
    descriptor: tasksRenderer,
    render: renderTasksSurface,
  },
  {
    descriptor: delegateStatusRenderer,
    render: renderDelegateSurface,
  },
  {
    descriptor: pauseStatusRenderer,
    render: (input) => {
      const model = input as PauseStatusViewModel;
      return (
        <div className="pause-status" role="status">
          {model.label}
        </div>
      );
    },
  },
];

/** Static imports are intentional: no filesystem discovery, eval, or runtime JS. */
export const dashboardRendererRegistry =
  createDashboardRendererRegistry(explicitRenderers);

export function resolveDashboardRenderer(
  rendererId: string | undefined,
): DashboardRenderer | undefined {
  return rendererId ? dashboardRendererRegistry.get(rendererId) : undefined;
}

export function renderDashboardContribution(
  rendererId: string | undefined,
  input: unknown,
  context?: DashboardRendererContext,
): ReactNode {
  const renderer = resolveDashboardRenderer(rendererId);
  if (!renderer) return genericUnknownRenderer(input, rendererId);
  if (!Value.Check(renderer.descriptor.inputSchema, input))
    return genericUnknownRenderer(input, rendererId);
  try {
    return renderer.render(input, context);
  } catch {
    return genericUnknownRenderer(input, rendererId);
  }
}
