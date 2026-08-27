import { describe, expect, it } from 'vitest';
import { analyticsSeries } from './usage-analytics';

describe('usage analytics series', () => {
  it('uses preferences by explicit provider/model identity for spend only', () => {
    const data = {
      buckets: [1],
      series: [
        {
          id: 'limit-a',
          limitId: 'limit-a',
          limitName: 'Requests',
          windowKind: 'primary',
          windowLabel: '5h',
          points: [],
        },
      ],
      spend: [
        {
          id: 'series-a',
          provider: 'provider-a',
          modelId: 'model-a',
          label: 'Configured alias',
          points: [],
        },
        {
          id: 'series-b',
          provider: 'provider-b',
          modelId: 'model-b',
          label: 'Other model',
          points: [],
        },
      ],
    } as never;
    const preferences = {
      'runtime-provider/model-a': {
        alias: 'Short model',
        color: '#ff79c6',
      },
    };

    const spend = analyticsSeries(data, 'cost', false, preferences);
    expect(spend).toMatchObject([
      { id: 'series-a', label: 'Short model', color: '#ff79c6' },
      { id: 'series-b', label: 'Other model', color: 'var(--pink)' },
    ]);

    const limits = analyticsSeries(data, 'limit', false, preferences);
    expect(limits[0]?.color).toBe('var(--purple)');
  });
});
