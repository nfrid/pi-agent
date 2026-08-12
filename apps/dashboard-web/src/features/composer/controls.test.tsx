import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComposerModelControl, ComposerThinkingControl } from './controls';

describe('composer controls', () => {
  it('keeps model and thinking controls controlled by their callers', () => {
    const markup = renderToStaticMarkup(
      <>
        <ComposerModelControl
          models={[{ provider: 'provider', model: 'model', name: 'Model' }]}
          value="provider/model"
          disabled
          onChange={() => undefined}
        />
        <ComposerThinkingControl
          levels={['off', 'high']}
          value="high"
          disabled={false}
          onChange={() => undefined}
        />
      </>,
    );
    expect(markup).toContain('aria-label="Model"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Model');
    expect(markup).toContain('aria-label="Thinking level"');
    expect(markup).toContain('value="high"');
  });

  it('does not render unavailable controls without an error', () => {
    expect(
      renderToStaticMarkup(
        <ComposerModelControl
          models={[]}
          value=""
          disabled={false}
          onChange={() => undefined}
        />,
      ),
    ).toBe('');
  });
});
