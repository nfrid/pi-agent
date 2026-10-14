import { expect, type Page, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

test.use({ serviceWorkers: 'allow' });

type Report = Record<string, unknown>;
const sharedEndpoint = 'https://push.example.test/subscription';

const snapshot = {
  serverId: 'push-foreground-browser-test',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [
    { id: 'thread/one', file: '/tmp/thread.jsonl', cwd: '/tmp', updatedAt: 1 },
    { id: 'other-thread', file: '/tmp/other.jsonl', cwd: '/tmp', updatedAt: 1 },
  ],
  unread: [],
};

async function preparePage(
  page: Page,
  reports: Map<Page, Report[]>,
  initialEndpoint: string | null,
): Promise<void> {
  await page.addInitScript((endpoint) => {
    Object.defineProperty(window, '__pushEndpoint', {
      configurable: true,
      value: endpoint,
      writable: true,
    });
    const foregroundState = { visible: true, focused: true };
    Object.defineProperty(window, '__foregroundState', {
      configurable: true,
      value: foregroundState,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (foregroundState.visible ? 'visible' : 'hidden'),
    });
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => foregroundState.focused,
    });
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      configurable: true,
      get: () =>
        Promise.resolve({
          pushManager: {
            getSubscription: async () =>
              (window as Window & { __pushEndpoint?: string | null })
                .__pushEndpoint
                ? {
                    endpoint: (window as Window & { __pushEndpoint: string })
                      .__pushEndpoint,
                  }
                : null,
          },
        }),
    });
  }, initialEndpoint);
  await installDashboardBootstrap(page, snapshot, { strictApi: true });
  reports.set(page, []);
  await page.route('**/api/push/foreground', async (route) => {
    reports
      .get(page)
      ?.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 204 });
  });
}

function latest(reports: Map<Page, Report[]>, page: Page): Report | undefined {
  return reports.get(page)?.at(-1);
}

async function expectLatest(
  reports: Map<Page, Report[]>,
  page: Page,
  expected: Partial<Report>,
): Promise<void> {
  await expect.poll(() => latest(reports, page)).toMatchObject(expected);
}

test('reports current focused routes, blur, refocus, and late subscriptions @desktop', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  const reports = new Map<Page, Report[]>();
  try {
    const matchingTab = await context.newPage();
    await preparePage(matchingTab, reports, sharedEndpoint);
    await matchingTab.goto(
      `${baseURL}/sessions/${encodeURIComponent('thread/one')}`,
    );
    await matchingTab.bringToFront();
    await expectLatest(reports, matchingTab, {
      endpoint: sharedEndpoint,
      visible: true,
      focused: true,
      sessionId: 'thread/one',
    });
    const matchingTabId = latest(reports, matchingTab)?.tabId;

    await matchingTab.evaluate(() => {
      history.pushState(null, '', '/sessions/other-thread');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expectLatest(reports, matchingTab, {
      visible: true,
      focused: true,
      sessionId: 'other-thread',
    });
    expect(latest(reports, matchingTab)?.tabId).toBe(matchingTabId);

    await matchingTab.evaluate(() => {
      history.pushState(null, '', '/runtimes/runtime%20one');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expectLatest(reports, matchingTab, {
      visible: true,
      focused: true,
      runtimeId: 'runtime one',
    });
    await matchingTab.evaluate(() => {
      history.pushState(null, '', '/sessions/other-thread');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expectLatest(reports, matchingTab, {
      visible: true,
      focused: true,
      sessionId: 'other-thread',
    });

    await matchingTab.evaluate(() => {
      const state = (
        window as Window & {
          __foregroundState: { visible: boolean; focused: boolean };
        }
      ).__foregroundState;
      state.visible = false;
      state.focused = false;
      document.dispatchEvent(new Event('visibilitychange'));
      dispatchEvent(new Event('blur'));
    });
    await expectLatest(reports, matchingTab, {
      visible: false,
      focused: false,
    });
    await matchingTab.evaluate(() => {
      const state = (
        window as Window & {
          __foregroundState: { visible: boolean; focused: boolean };
        }
      ).__foregroundState;
      state.visible = true;
      state.focused = true;
      dispatchEvent(new Event('focus'));
    });
    await expectLatest(reports, matchingTab, {
      visible: true,
      focused: true,
      sessionId: 'other-thread',
    });
    expect(latest(reports, matchingTab)?.tabId).toBe(matchingTabId);

    await matchingTab.evaluate(() => {
      history.pushState(null, '', '/');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expectLatest(reports, matchingTab, {
      visible: false,
      focused: false,
    });
    expect(latest(reports, matchingTab)?.sessionId).toBeUndefined();
    expect(latest(reports, matchingTab)?.runtimeId).toBeUndefined();

    const lateSubscriptionTab = await context.newPage();
    await preparePage(lateSubscriptionTab, reports, null);
    await lateSubscriptionTab.goto(`${baseURL}/sessions/other-thread`);
    expect(reports.get(lateSubscriptionTab)).toHaveLength(0);
    await lateSubscriptionTab.evaluate((endpoint) => {
      (window as Window & { __pushEndpoint?: string | null }).__pushEndpoint =
        endpoint;
      const state = (
        window as Window & {
          __foregroundState: { visible: boolean; focused: boolean };
        }
      ).__foregroundState;
      state.visible = true;
      state.focused = true;
      dispatchEvent(new Event('focus'));
    }, sharedEndpoint);
    await expectLatest(reports, lateSubscriptionTab, {
      endpoint: sharedEndpoint,
      visible: true,
      focused: true,
      sessionId: 'other-thread',
    });
    const lateTabId = latest(reports, lateSubscriptionTab)?.tabId;
    expect(typeof lateTabId).toBe('string');
    expect(lateTabId).not.toBe(matchingTabId);
  } finally {
    await context.close();
  }
});

test('dashboard renders when PushManager and secure-context UUID support are absent @desktop', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'PushManager');
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: undefined,
      });
    });
    await installDashboardBootstrap(page, snapshot, { strictApi: true });
    await page.route('**/api/push/foreground', (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.goto(`${baseURL}/`);
    await expect(page.locator('main.shell')).toBeVisible();
  } finally {
    await context.close();
  }
});
