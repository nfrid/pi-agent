import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RuntimeModelControl,
  RuntimeThinkingControl,
} from './runtime-controls';

const runtime = {
  runtimeId: 'runtime-1',
  liveState: 'idle',
  online: true,
  model: { provider: 'provider', model: 'model', thinking: 'off' },
  modelCatalog: [{ provider: 'provider', model: 'model', name: 'Model' }],
  thinkingLevels: ['off', 'high'],
} as unknown as RuntimeSnapshot;

function renderControls(value: RuntimeSnapshot) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RuntimeModelControl runtime={value} runtimes={[value]} />
      <RuntimeThinkingControl runtime={value} />
    </QueryClientProvider>,
  );
}

describe('composer runtime control adapters', () => {
  it('derives controlled values and options from the runtime snapshot', () => {
    const markup = renderControls(runtime);
    expect(markup).toContain('aria-label="Model"');
    expect(markup).toContain('Model');
    expect(markup).toContain('aria-label="Thinking level"');
    expect(markup).toContain('value="off"');
  });

  it('disables commands while the runtime cannot accept control updates', () => {
    const markup = renderControls({
      ...runtime,
      online: false,
      liveState: 'stopping',
    });
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});
