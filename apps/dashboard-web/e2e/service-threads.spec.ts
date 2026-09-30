import { expect, test } from '@playwright/test';
import {
  buildActivityPanelScenario,
  installVisualStateScenario,
} from './visual-state-fixtures';

test('service threads stay out of default search and can be revealed and opened', async ({
  page,
}) => {
  const scenario = buildActivityPanelScenario(true);
  const sessionId = 'working-session';
  const title = 'Internal service build';
  scenario.snapshot.sessions = [
    ...scenario.snapshot.sessions.map((session) =>
      session.id === sessionId ? { ...session, title } : session,
    ),
    {
      id: 'ordinary-session',
      cwd: '/workspace/dashboard',
      title: 'Ordinary project thread',
      projectId: 'visual-project',
      updatedAt: Date.now(),
    },
  ];
  scenario.snapshot.runtimes = scenario.snapshot.runtimes.map((runtime) =>
    runtime.session.id === sessionId
      ? { ...runtime, session: { ...runtime.session, title } }
      : runtime,
  );
  scenario.snapshot.threads = [
    {
      id: 'ordinary-thread',
      projectId: 'visual-project',
      title: 'Ordinary project thread',
      checkoutId: 'visual-checkout',
      status: 'running',
      activeRunId: 'ordinary-run',
      updatedAt: Date.now(),
    },
    {
      id: 'service-thread',
      projectId: 'visual-project',
      title,
      checkoutId: 'visual-checkout',
      isService: true,
      status: 'running',
      activeRunId: 'service-run',
      updatedAt: Date.now(),
    },
  ];
  scenario.snapshot.runs = [
    {
      id: 'ordinary-run',
      threadId: 'ordinary-thread',
      checkoutId: 'visual-checkout',
      attempt: 1,
      mode: 'write',
      runtimeProvider: 'pi',
      piSessionId: 'ordinary-session',
      status: 'running',
      createdAt: Date.now(),
    },
    {
      id: 'service-run',
      threadId: 'service-thread',
      checkoutId: 'visual-checkout',
      attempt: 1,
      mode: 'write',
      runtimeProvider: 'pi',
      runtimeId: 'working-runtime',
      piSessionId: sessionId,
      status: 'running',
      createdAt: Date.now(),
    },
  ];
  const sessionSnapshot = scenario.sessionSnapshot;
  if (!sessionSnapshot)
    throw new Error('Scenario session snapshot is missing.');
  const fixture = {
    ...scenario,
    sessionSnapshot: {
      ...sessionSnapshot,
      metadata: { ...sessionSnapshot.metadata, title },
    },
  };
  const directPage = await page.context().newPage();
  await directPage.route('**/api/projects/*/icon', (route) =>
    route.fulfill({ status: 404 }),
  );
  await installVisualStateScenario(directPage, fixture);
  await expect(
    directPage.getByRole('textbox', { name: 'Message Pi' }),
  ).toBeVisible();
  await expect(directPage).toHaveURL(/\/sessions\/working-session$/);
  await directPage.close();

  await page.route('**/api/projects/*/icon', (route) =>
    route.fulfill({ status: 404 }),
  );
  await installVisualStateScenario(page, fixture);
  await page.setViewportSize({ width: 393, height: 851 });
  await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible();

  await page.getByRole('button', { name: 'Open agent list' }).tap();
  const panel = page.locator('.agent-thread-nav');
  const search = panel.getByRole('searchbox', {
    name: 'Search agents and threads',
  });
  await search.fill('Ordinary project thread');
  await expect(
    panel.getByRole('button', { name: 'Ordinary project thread ready' }),
  ).toBeVisible();
  await search.fill('Internal service build');
  await expect(
    panel.getByRole('button', { name: /Internal service build/ }),
  ).toHaveCount(0);

  await panel.getByRole('checkbox', { name: 'Show service threads' }).check();
  await search.fill('Internal service build');
  const thread = panel.getByRole('button', { name: /Internal service build/ });
  await expect(thread).toBeVisible();
  await thread.click();
  await expect(page).toHaveURL(/\/sessions\/working-session$/);
  await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible();
});
