import {
  isTypeBoxSchema,
  type RendererDescriptor,
} from '@pi-dashboard/extension-contributions';
import type { ReactNode } from 'react';
import { Value } from 'typebox/value';
import { activityGroupsRenderer } from '../../../extensions/activity-groups/contribution';
import { askUserRenderer } from '../../../extensions/ask-user/contribution';

export interface DashboardRenderer {
  readonly descriptor: RendererDescriptor;
  readonly render: (input: unknown) => ReactNode;
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
      const value = input as { question?: unknown };
      return (
        <p>
          {typeof value.question === 'string'
            ? value.question
            : 'Question unavailable.'}
        </p>
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
      return (
        <div className="activity-renderer-fallback">
          <strong>
            {typeof value.title === 'string' ? value.title : 'Activity group'}
          </strong>
          <small>
            {String(value.status ?? 'unknown')} · {String(value.toolCount ?? 0)}{' '}
            calls
          </small>
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
): ReactNode {
  const renderer = resolveDashboardRenderer(rendererId);
  if (!renderer) return genericUnknownRenderer(input, rendererId);
  if (!Value.Check(renderer.descriptor.inputSchema, input))
    return genericUnknownRenderer(input, rendererId);
  try {
    return renderer.render(input);
  } catch {
    return genericUnknownRenderer(input, rendererId);
  }
}
