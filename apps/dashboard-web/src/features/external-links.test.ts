import { describe, expect, it } from 'vitest';
import { externalWebUrl, ordinaryClick } from './external-links';

describe('external link eligibility', () => {
  it('accepts external HTTP URLs and rejects same-origin, unsafe, and credential URLs', () => {
    expect(
      externalWebUrl('https://example.com/docs', 'http://127.0.0.1:4174/'),
    ).toBe('https://example.com/docs');
    expect(
      externalWebUrl('/sessions/one', 'http://127.0.0.1:4174/'),
    ).toBeUndefined();
    expect(
      externalWebUrl('mailto:hello@example.com', 'http://127.0.0.1:4174/'),
    ).toBeUndefined();
    expect(
      externalWebUrl('file:///tmp/a.txt', 'http://127.0.0.1:4174/'),
    ).toBeUndefined();
    expect(
      externalWebUrl(
        'https://user:pass@example.com/',
        'http://127.0.0.1:4174/',
      ),
    ).toBeUndefined();
    expect(
      externalWebUrl(
        'http://127.0.0.1:4174/settings',
        'http://127.0.0.1:4174/',
      ),
    ).toBeUndefined();
  });

  it('accepts only unmodified, unprevented primary clicks', () => {
    expect(ordinaryClick({ button: 0 } as MouseEvent)).toBe(true);
    for (const event of [
      { button: 0, defaultPrevented: true },
      { button: 1 },
      { button: 0, metaKey: true },
      { button: 0, ctrlKey: true },
      { button: 0, shiftKey: true },
      { button: 0, altKey: true },
    ])
      expect(ordinaryClick(event as MouseEvent)).toBe(false);
  });
});
