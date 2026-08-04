import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
  createDashboardRendererRegistry,
  genericUnknownRenderer,
  renderDashboardContribution,
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
