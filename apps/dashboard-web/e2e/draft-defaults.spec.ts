import { expect, test } from '@playwright/test';
import { installDashboardBootstrap, trpcData } from './dashboard-fixtures';

const fastModel = {
  provider: 'openai-codex',
  model: 'gpt-5',
  serviceTier: 'fast' as const,
};
const ultrafastModel = {
  ...fastModel,
  serviceTier: 'ultrafast' as const,
};

function projectResponse(defaultModel: typeof fastModel | undefined) {
  return {
    id: 'project-defaults',
    title: 'Draft defaults project',
    rootPath: '/tmp/draft-defaults-project',
    defaultModel,
    defaultIsolation: 'main',
    maxParallelRuns: 1,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };
}

test('global and project defaults override/reset and pin draft launch', async ({
  page,
}) => {
  let globalDefault: typeof fastModel | undefined;
  let projectDefault: typeof fastModel | undefined;
  let createdCommand: Record<string, unknown> | undefined;
  const settings = () => ({
    modelDisplayPreferences: {},
    ...(globalDefault ? { defaultModel: globalDefault } : {}),
  });
  const defaults = () => {
    const selection = projectDefault ?? globalDefault;
    return selection
      ? {
          selection,
          source: projectDefault ? 'project' : 'dashboard',
        }
      : {};
  };
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/projects/project-defaults/icon', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await page.route('**/api/settings', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(settings()),
    }),
  );
  await page.route('**/api/settings/default-model', async (route) => {
    if (route.request().method() === 'PUT')
      globalDefault = JSON.parse(route.request().postData() ?? '{}');
    else if (route.request().method() === 'DELETE') globalDefault = undefined;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(settings()),
    });
  });
  await page.route('**/api/projects/project-defaults', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        defaultModel?: typeof fastModel | null;
      };
      projectDefault = body.defaultModel ?? undefined;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(projectResponse(projectDefault)),
      });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/projects/project-defaults/draft-defaults', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(defaults()),
    }),
  );
  await page.route('**/api/projects/project-defaults/git-context', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        branch: 'main',
        dirty: false,
        changedFileCount: 0,
        localBranches: ['main'],
      }),
    }),
  );
  await page.route('**/api/session-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/threads*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/trpc/composerCommands*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData({ commands: [] }),
    }),
  );
  await page.route(
    '**/api/projects/project-defaults/threads',
    async (route) => {
      createdCommand = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: 'thread-defaults' },
          run: { id: 'run-defaults' },
          receipt: { id: 'receipt-defaults' },
        }),
      });
    },
  );

  await installDashboardBootstrap(page, {
    serverId: 'draft-defaults-e2e',
    revision: 1,
    cursor: 1,
    runtimes: [
      {
        runtimeId: 'runtime-defaults',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp/draft-defaults-project',
        liveState: 'idle',
        online: true,
        modelCatalog: [
          {
            provider: 'openai-codex',
            model: 'gpt-5',
            name: 'Fast model',
            supportsImages: true,
          },
        ],
        thinkingLevels: ['high'],
        session: { id: 'session-defaults', entries: [] },
      },
    ],
    projects: [
      {
        id: 'project-defaults',
        title: 'Draft defaults project',
        rootPath: '/tmp/draft-defaults-project',
        status: 'active',
      },
    ],
    checkouts: [
      {
        id: 'checkout-defaults',
        projectId: 'project-defaults',
        kind: 'main',
        path: '/tmp/draft-defaults-project',
        branch: 'main',
        status: 'ready',
        updatedAt: 1,
      },
    ],
    sessions: [],
    threads: [],
    runs: [],
    unread: [],
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const nav = page.getByRole('complementary', { name: 'Agents and threads' });
  await nav.getByRole('button', { name: 'Open settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await expect(drawer).toBeVisible();

  await drawer.getByLabel('Dashboard model').selectOption('openai-codex/gpt-5');
  await drawer.getByLabel('Dashboard speed').selectOption('fast');
  await expect.poll(() => globalDefault).toEqual(fastModel);

  const projectRow = drawer
    .locator('[class*="defaultModelRow"]')
    .filter({ hasText: 'Draft defaults project' });
  await projectRow
    .getByLabel('Draft defaults project model')
    .selectOption('openai-codex/gpt-5');
  await projectRow
    .getByLabel('Draft defaults project speed')
    .selectOption('ultrafast');
  await expect.poll(() => projectDefault).toEqual(ultrafastModel);

  await projectRow.getByRole('button', { name: 'Reset to inherit' }).click();
  await expect(
    projectRow.getByLabel('Draft defaults project model'),
  ).toHaveValue('');
  await expect.poll(() => projectDefault).toBeUndefined();

  await drawer
    .getByRole('button', { name: 'Close Settings' })
    .click({ force: true });
  await expect(drawer).toHaveCount(0);
  await page.goto('/projects/project-defaults/new');
  await expect(page.getByRole('heading', { name: 'New thread' })).toBeVisible();
  const agent = page.getByRole('button', { name: 'Agent and thinking' });
  await expect(agent).toContainText('Fast model');
  await expect(agent.getByRole('img', { name: 'Fast' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message Pi' });
  await composer.fill('Use the fast inherited default.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect
    .poll(() => createdCommand)
    .toMatchObject({
      model: fastModel,
    });

  await page.goBack();
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page
    .getByRole('complementary', { name: 'Agents and threads' })
    .getByRole('button', { name: 'Open settings' })
    .click();
  const reopened = page.getByRole('dialog', { name: 'Settings' });
  const globalRow = reopened
    .locator('[class*="defaultModelRow"]')
    .filter({ hasText: 'Dashboard' });
  await globalRow.getByRole('button', { name: 'Reset to inherit' }).click();
  await expect(globalRow.getByLabel('Dashboard model')).toHaveValue('');
  await expect.poll(() => globalDefault).toBeUndefined();
});
