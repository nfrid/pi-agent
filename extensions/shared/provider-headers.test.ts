import { describe, expect, it } from 'vitest';
import { fetchHeaders } from './provider-headers';

describe('fetchHeaders', () => {
  it('filters Pi null deletion markers for ordinary fetch', () => {
    expect(
      fetchHeaders({
        Authorization: 'Bearer token',
        'x-remove': null,
        'x-extra': 'value',
      }),
    ).toEqual({
      Authorization: 'Bearer token',
      'x-extra': 'value',
    });
  });

  it('accepts missing provider headers', () => {
    expect(fetchHeaders(undefined)).toEqual({});
  });
});
