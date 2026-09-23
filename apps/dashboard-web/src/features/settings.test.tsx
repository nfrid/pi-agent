import { dashboardHttpClient, dashboardQueryKeys } from '@pi-dashboard/client';
import type {
  BrowserSnapshot,
  DashboardSettings,
} from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelOptionValue } from './model-option';
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

  it('disables a default row until its save settles', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(dashboardQueryKeys.settings(), {
      modelDisplayPreferences: {},
      defaultModel: { provider: 'openai', model: 'gpt-5' },
    });
    let resolveSave!: (value: unknown) => void;
    const savePending = new Promise((resolve) => {
      resolveSave = resolve;
    });
    const update = vi
      .spyOn(dashboardHttpClient, 'updateDashboardDefaultModel')
      .mockReturnValue(savePending as Promise<never>);
    const controlSnapshot = {
      ...snapshot,
      runtimes: [
        {
          modelCatalog: [
            { provider: 'openai', model: 'gpt-5' },
            { provider: 'openai', model: 'gpt-4' },
          ],
        },
      ],
    } as unknown as BrowserSnapshot;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <SettingsView snapshot={controlSnapshot} />
        </QueryClientProvider>,
      );
    });
    const control = renderer.root.findAllByProps({
      'aria-label': 'Dashboard model',
    })[0];
    if (!control) throw new Error('Missing dashboard default control.');
    await act(async () => {
      control.props.onChange({
        currentTarget: { value: modelOptionValue('openai', 'gpt-4') },
      });
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    });
    expect(control.props.disabled).toBe(true);
    resolveSave({
      modelDisplayPreferences: {},
      defaultModel: { provider: 'openai', model: 'gpt-4' },
    });
    await act(async () => {
      await savePending;
    });
    expect(control.props.disabled).toBe(false);
    renderer.unmount();
  });

  it('rolls back a failed default save and reflects project reset', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(dashboardQueryKeys.settings(), {
      modelDisplayPreferences: {},
      defaultModel: { provider: 'openai', model: 'gpt-5' },
    });
    const updateGlobal = vi
      .spyOn(dashboardHttpClient, 'updateDashboardDefaultModel')
      .mockRejectedValue(new Error('save failed'));
    const updateProject = vi
      .spyOn(dashboardHttpClient, 'updateProjectDefaultModel')
      .mockResolvedValue({
        id: 'project-1',
        title: 'Dashboard',
        rootPath: '/tmp/dashboard',
        createdAt: 1,
        defaultModel: { provider: 'openai', model: 'gpt-5' },
        defaultIsolation: 'main',
        maxParallelRuns: 1,
        status: 'active',
        updatedAt: 1,
      });
    const controlSnapshot = {
      ...snapshot,
      runtimes: [
        {
          modelCatalog: [
            { provider: 'openai', model: 'gpt-5' },
            { provider: 'openai', model: 'gpt-4' },
          ],
        },
      ],
      projects: [
        {
          ...snapshot.projects?.[0],
          title: 'Project settings',
          defaultModel: { provider: 'openai', model: 'gpt-5' },
        },
      ],
    } as unknown as BrowserSnapshot;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <SettingsView snapshot={controlSnapshot} />
        </QueryClientProvider>,
      );
    });
    const globalControl = renderer.root.findByProps({
      'aria-label': 'Dashboard model',
    });
    await act(async () => {
      globalControl.props.onChange({
        currentTarget: { value: modelOptionValue('openai', 'gpt-4') },
      });
      await vi.waitFor(() => expect(updateGlobal).toHaveBeenCalledOnce());
    });
    await vi.waitFor(() =>
      expect(globalControl.props.value).toBe(
        modelOptionValue('openai', 'gpt-5'),
      ),
    );

    const projectControl = renderer.root.findByProps({
      'aria-label': 'Project settings model',
    });
    const resetButtons = renderer.root
      .findAllByType('button')
      .filter((candidate) => candidate.props.children === 'Reset to inherit');
    const projectReset = resetButtons.at(-1);
    expect(projectReset).toBeDefined();
    await act(async () => {
      projectReset?.props.onClick();
      await vi.waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
    });
    await vi.waitFor(() => expect(projectControl.props.value).toBe(''));
    renderer.unmount();
  });

  it('allows manual model entry when no runtime catalog is available', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(dashboardQueryKeys.settings(), {
      modelDisplayPreferences: {},
    });
    const update = vi
      .spyOn(dashboardHttpClient, 'updateDashboardDefaultModel')
      .mockResolvedValue({ modelDisplayPreferences: {} });
    const emptySnapshot = {
      projects: [],
      runtimes: [],
    } as unknown as BrowserSnapshot;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <SettingsView snapshot={emptySnapshot} />
        </QueryClientProvider>,
      );
    });
    const effort = renderer.root.findByProps({
      'aria-label': 'Dashboard effort',
    });
    expect(
      effort.findAllByType('option').map((option) => option.props.value),
    ).toContain('medium');
    const provider = renderer.root.findByProps({
      'aria-label': 'Dashboard provider',
    });
    const model = renderer.root.findByProps({
      'aria-label': 'Dashboard model id',
    });
    await act(async () => {
      provider.props.onChange({ currentTarget: { value: 'openai-codex' } });
      model.props.onChange({ currentTarget: { value: 'gpt-5' } });
    });
    const useModel = renderer.root
      .findAllByType('button')
      .find((candidate) => candidate.props.children === 'Use model');
    if (!useModel) throw new Error('Missing manual model button.');
    await act(async () => {
      useModel.props.onClick();
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    });
    expect(update).toHaveBeenCalledWith({
      provider: 'openai-codex',
      model: 'gpt-5',
    });
    renderer.unmount();
  });

  it('can unhide and reset a disconnected model without changing its default', async () => {
    const key = 'provider/model/with/slash';
    let settings: DashboardSettings = {
      modelDisplayPreferences: { [key]: { alias: 'Saved', hidden: true } },
      defaultModel: { provider: 'provider', model: 'model/with/slash' },
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(dashboardQueryKeys.settings(), settings);
    vi.spyOn(dashboardHttpClient, 'settings').mockImplementation(
      async () => settings,
    );
    const update = vi
      .spyOn(dashboardHttpClient, 'updateModelDisplayPreference')
      .mockImplementation(async (modelKey, preference) => {
        settings = {
          ...settings,
          modelDisplayPreferences: { [modelKey]: preference },
        };
        return settings;
      });
    const reset = vi
      .spyOn(dashboardHttpClient, 'resetModelDisplayPreference')
      .mockImplementation(async () => {
        settings = { ...settings, modelDisplayPreferences: {} };
        return settings;
      });
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <SettingsView
            snapshot={
              { runtimes: [], projects: [] } as unknown as BrowserSnapshot
            }
          />
        </QueryClientProvider>,
      );
    });
    const checkbox = renderer.root.findByProps({
      'aria-label': `Hide ${key} from selectors`,
    });
    const defaultControl = renderer.root.findByProps({
      'aria-label': 'Dashboard model',
    });
    expect(checkbox.props.checked).toBe(true);
    expect(defaultControl.props.value).toBe(
      modelOptionValue('provider', 'model/with/slash'),
    );
    expect(
      defaultControl
        .findAllByType('option')
        .find((option) => option.props.value)?.props.disabled,
    ).toBe(true);
    const target = { checked: false };
    await act(async () => {
      checkbox.props.onChange({ currentTarget: target });
      target.checked = true;
      await vi.waitFor(() =>
        expect(update).toHaveBeenCalledWith(key, {
          alias: 'Saved',
          hidden: false,
        }),
      );
    });
    expect(checkbox.props.checked).toBe(false);
    expect(
      defaultControl
        .findAllByType('option')
        .find((option) => option.props.value)?.props.disabled,
    ).not.toBe(true);
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.props.children === 'Reset')
        ?.props.onClick();
      await vi.waitFor(() => expect(reset).toHaveBeenCalledWith(key));
    });
    expect(settings.modelDisplayPreferences).toEqual({});
    expect(settings.defaultModel).toEqual({
      provider: 'provider',
      model: 'model/with/slash',
    });
    renderer.unmount();
    queryClient.clear();
  });

  it('restores visibility and shows an error if saving fails', async () => {
    const settings = { modelDisplayPreferences: {} };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(dashboardQueryKeys.settings(), settings);
    vi.spyOn(dashboardHttpClient, 'settings').mockResolvedValue(settings);
    const update = vi
      .spyOn(dashboardHttpClient, 'updateModelDisplayPreference')
      .mockRejectedValue(new Error('save failed'));
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <SettingsView snapshot={snapshot} />
        </QueryClientProvider>,
      );
    });
    const checkbox = renderer.root.findByProps({
      'aria-label': 'Hide openai/gpt-5 from selectors',
    });
    await act(async () => {
      checkbox.props.onChange({ currentTarget: { checked: true } });
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    });
    await vi.waitFor(() => expect(checkbox.props.checked).toBe(false));
    expect(renderer.root.findByProps({ role: 'alert' }).props.children).toBe(
      'Could not save model display settings.',
    );
    renderer.unmount();
    queryClient.clear();
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
