import { dashboardHttpClient, dashboardQueryKeys } from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from './settings';

const snapshot = {
  runtimes: [
    {
      model: { provider: 'openai', model: 'gpt-5' },
      modelCatalog: [{ provider: 'openai', model: 'gpt-5', name: 'GPT-5' }],
    },
  ],
  projects: [
    {
      id: 'project-1',
      title: 'Dashboard',
      rootPath: '/tmp/dashboard',
      status: 'active',
    },
  ],
} as unknown as BrowserSnapshot;

describe('settings drawer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps delivery controls and project administration compact', () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsView snapshot={snapshot} />
      </QueryClientProvider>,
    );
    expect(markup).toContain('Alert delivery');
    expect(markup).toContain('Browser push');
    expect(markup).toContain('Enable push');
    expect(markup).not.toContain('Read all');
    expect(markup).not.toContain('Notifications');
    expect(markup).not.toContain('Browser alerts');
    expect(markup).toContain('Transcript');
    expect(markup).toContain('Steps shown from start');
    expect(markup).toContain('Steps shown from end');
    expect(markup).toContain('value="1"');
    expect(markup).toContain('value="3"');
    expect(markup).toContain('Model display');
    expect(markup).toContain('<details');
    expect(markup).not.toContain('<details open=""');
    expect(markup).toContain('Alias for openai/gpt-5');
    expect(markup).toContain('Use Purple for openai/gpt-5');
    expect(markup).toContain('Use Yellow for openai/gpt-5');
    expect(markup).toContain('Custom color for openai/gpt-5');
    expect(markup).toContain('Projects');
    expect(markup).toContain('Dashboard');
    expect(markup).toContain('aria-label="Choose icon for Dashboard"');
    expect(markup).not.toContain('Automatic');
    expect(markup).toContain('Rename');
    expect(markup).not.toContain('Remove');
  });

  it('captures alias text before asynchronously cancelling stale queries', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(dashboardQueryKeys.settings(), {
      modelDisplayPreferences: {},
    });
    const update = vi
      .spyOn(dashboardHttpClient, 'updateModelDisplayPreference')
      .mockResolvedValue({
        modelDisplayPreferences: {
          'openai/gpt-5': { alias: 'Turbo model' },
        },
      });
    const target = { value: 'Turbo model' };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <SettingsView snapshot={snapshot} />
        </QueryClientProvider>,
      );
    });
    const input = renderer.root.findByProps({
      'aria-label': 'Alias for openai/gpt-5',
    });
    await act(async () => {
      input.props.onChange({ currentTarget: target });
      target.value = '';
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    });
    expect(update).toHaveBeenCalledWith('openai/gpt-5', {
      alias: 'Turbo model',
    });
    renderer.unmount();
  });
});
