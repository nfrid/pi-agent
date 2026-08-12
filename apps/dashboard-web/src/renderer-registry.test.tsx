import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
  createDashboardRendererRegistry,
  dashboardRendererRegistry,
  genericUnknownRenderer,
  renderDashboardContribution,
  resolveDashboardRenderer,
} from './renderer-registry';

describe('dashboard renderer registry', () => {
  it('rejects duplicate IDs and invalid schemas at construction', () => {
    const descriptor = {
      id: 'test.renderer',
      mode: 'generic' as const,
      inputSchema: Type.Object({}, { additionalProperties: false }),
    };
    expect(() =>
      createDashboardRendererRegistry([
        { descriptor, render: () => null },
        { descriptor, render: () => null },
      ]),
    ).toThrow('Duplicate dashboard renderer ID');
    expect(() =>
      createDashboardRendererRegistry([
        {
          descriptor: { ...descriptor, inputSchema: {} as never },
          render: () => null,
        },
      ]),
    ).toThrow('valid schema');
  });

  it('registers task, delegate, and pause adapters by exact trusted IDs', () => {
    expect(resolveDashboardRenderer('tasks.current')).toBe(
      dashboardRendererRegistry.get('tasks.current'),
    );
    expect(resolveDashboardRenderer('delegate.status')).toBe(
      dashboardRendererRegistry.get('delegate.status'),
    );
    expect(resolveDashboardRenderer('runtime.pause-status')).toBe(
      dashboardRendererRegistry.get('runtime.pause-status'),
    );
    expect(resolveDashboardRenderer('runtime.delegate.status')).toBeUndefined();
    expect(
      renderDashboardContribution('tasks.current', {
        version: 1,
        tasks: [],
        stats: { total: 0, active: 0, done: 0, blocked: 0, ready: 0 },
      }),
    ).toMatchObject({ type: expect.any(Function) });
    expect(
      renderDashboardContribution('delegate.status', {
        version: 1,
        statuses: [],
      }),
    ).toMatchObject({ type: expect.any(Function) });
    expect(
      renderDashboardContribution('runtime.pause-status', {
        version: 1,
        phase: 'paused',
        delegateCount: 2,
        label: 'Paused (with 2 delegates)',
      }),
    ).toMatchObject({
      type: 'div',
      props: {
        role: 'status',
        children: 'Paused (with 2 delegates)',
      },
    });
  });

  it('uses a generic fallback for unknown and invalid renderer payloads', () => {
    const unknown = genericUnknownRenderer(
      { value: 'safe' },
      'missing.renderer',
    );
    expect(unknown).toMatchObject({ props: { children: expect.anything() } });
    const invalid = renderDashboardContribution('ask-user.question', {
      question: 42,
    });
    expect(invalid).toMatchObject({
      props: { children: expect.anything() },
    });
  });
});
