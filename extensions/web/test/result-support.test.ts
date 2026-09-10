import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/cache-files', () => ({
  CACHE_FILE_MAX_BYTES: 32,
  writeCacheFile: vi.fn(() => {
    throw new Error('oversized results must not reach file persistence');
  }),
}));

import { boundedPreview, persistWebResult } from '../result-support';
import { createWebResultStore } from '../storage';

describe('web result persistence', () => {
  it('bounds the preview and manifest together while retaining a summary ID', () => {
    const manifest = [
      'Content ID manifest:',
      '- Summary: summary-id',
      ...Array.from(
        { length: 160 },
        (_, index) => `- Page: page-${index} — ${'title'.repeat(100)}`,
      ),
    ].join('\n');
    const preview = boundedPreview(
      'x'.repeat(20_000),
      'summary-id',
      true,
      manifest,
    );
    expect(preview.rendered.length).toBeLessThanOrEqual(12_000);
    expect(preview.rendered).toContain('- Summary: summary-id');
    expect(preview.rendered).toContain('More content IDs');
    expect(preview.details.nextOffset).toBeGreaterThan(0);
  });

  it('does not append an unavailable content ID manifest', () => {
    expect(
      boundedPreview('body', 'content-id', false, 'Content ID: content-id')
        .rendered,
    ).toBe('body');
  });

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
      continuationAvailable: true,
    });
    expect(store.get(data.id)).toEqual(data);
    expect(store.cacheFile(data.id)).toBeUndefined();
  });
});
