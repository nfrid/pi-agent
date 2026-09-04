import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ServiceTierIcon } from './service-tier-icon';

describe('service tier icon', () => {
  it('renders one bolt for fast and two for ultrafast', () => {
    expect(renderToStaticMarkup(<ServiceTierIcon tier="fast" />)).toContain(
      'aria-label="Fast"',
    );
    expect(
      renderToStaticMarkup(<ServiceTierIcon tier="fast" />).match(/<path/g),
    ).toHaveLength(1);
    expect(
      renderToStaticMarkup(<ServiceTierIcon tier="ultrafast" />).match(
        /<path/g,
      ),
    ).toHaveLength(2);
  });
});
