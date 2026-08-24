import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RuntimeAgentControl } from './runtime-controls';

const runtime = {
  runtimeId: 'runtime-1',
  liveState: 'idle',
  online: true,
  model: { provider: 'provider', model: 'model', thinking: 'off' },
  modelCatalog: [{ provider: 'provider', model: 'model', name: 'Model' }],
  thinkingLevels: ['off', 'high'],
} as unknown as RuntimeSnapshot;

function renderControl(value: RuntimeSnapshot) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RuntimeAgentControl runtime={value} runtimes={[value]} />
    </QueryClientProvider>,
  );
}

describe('composer runtime agent adapter', () => {
  it('derives the compact control value from the runtime snapshot', () => {
    const markup = renderControl(runtime);
    expect(markup).toContain('aria-label="Agent and thinking"');
    expect(markup).toContain('Model');
    expect(markup).toContain('off');
  });

  it('disables the control while the runtime cannot accept updates', () => {
    const markup = renderControl({
      ...runtime,
      online: false,
      liveState: 'stopping',
    });
    expect(markup).toContain('disabled=""');
  });
});
