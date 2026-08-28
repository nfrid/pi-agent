import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/cache-files', () => ({
  CACHE_FILE_MAX_BYTES: 32,
  writeCacheFile: vi.fn(() => {
    throw new Error('oversized results must not reach file persistence');
  }),
}));

import { persistWebResult } from '../result-support';
import { createWebResultStore } from '../storage';

describe('web result persistence', () => {
  it('keeps oversized results available for in-process continuation', async () => {
    const store = createWebResultStore();
    const data = {
      id: 'oversized',
      type: 'fetch' as const,
      timestamp: 1,
      urls: [
        {
          url: 'https://example.com',
          title: 'Example',
          content: 'x'.repeat(256),
          error: null,
        },
      ],
    };

    const payload = await persistWebResult(store, data, () => undefined);

    expect(payload).toEqual({
      warning:
        'Exact cache file unavailable; aggregate result exceeded the cache-file limit.',
    });
    expect(store.get(data.id)).toEqual(data);
    expect(store.cacheFile(data.id)).toBeUndefined();
  });
});
