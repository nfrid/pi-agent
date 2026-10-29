import { expect, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
} from './dashboard-fixtures';

const snapshot = {
  serverId: 'external-links-test',
  revision: 1,
  cursor: 1,
  runtimes: [],
  sessions: [
    {
      id: 'external-links-session',
      file: '/tmp/external-links.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    },
  ],
  unread: [],
};

test('installed local PWA opens ordinary external links natively and preserves other link behavior @desktop', async ({
  page,
  baseURL,
}) => {
  const requests: Array<{ procedure: string; input: Record<string, unknown> }> =
    [];
  let openResult: { opened: boolean } = { opened: true };
  let helperAvailable = true;
  let statusRequests = 0;
  const localOrigin = 'http://127.0.0.1:4174';
  const testOrigin = new URL(baseURL).origin;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !== localOrigin &&
      url.origin !== `http://localhost:${new URL(baseURL).port}`
    )
      return route.abort();
    return route.fulfill({
      response: await route.fetch({
        url: `${baseURL}${url.pathname}${url.search}`,
      }),
    });
  });
  await page.route('**/trpc/nativeControl', (route) => {
    statusRequests++;
    return route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        available: helperAvailable,
        enabled: false,
        permission: 'not-determined',
      }),
    });
  });
  await page.route('**/trpc/nativeOpenExternal', (route) => {
    requests.push({
      procedure: 'nativeOpenExternal',
      input: dashboardTrpcInput(route.request()),
    });
    return route.fulfill({
      contentType: 'application/json',
      body: trpcData(openResult),
    });
  });
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      query === '(display-mode: window-controls-overlay)'
        ? { ...original(query), matches: true }
        : original(query);
  });
  await installDashboardBootstrap(page, snapshot, {
    sessionSnapshot: {
      entries: [
        {
          type: 'message',
          id: 'external-message',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: [
                  '[Markdown external](https://example.com/markdown)',
                  '[Modified](https://example.com/modified)',
                  '[Middle](https://example.com/middle)',
                  '[Download](https://example.com/download)',
                  '[Prevented](https://example.com/prevented)',
                  '[Internal](http://127.0.0.1:4174/sessions/external-links-session)',
                  '[File](file.ts:1)',
                ].join(' '),
              },
            ],
          },
        },
      ],
      entriesComplete: true,
      active: { messages: [], tools: [], delegates: [], truncated: false },
      completeThroughCursor: true,
    },
  });
  await page.context().route('https://**/*', (route) => {
    if (new URL(route.request().url()).pathname === '/download')
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="test.txt"',
        },
        body: 'test',
      });
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<title>mock</title>',
    });
  });
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, body: '{}' }),
  );
  await page.route('**/trpc/nativeClicks**', (route) => route.abort());
  await page.route('**/trpc/readFile*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        path: '/tmp/file.ts',
        content: 'export const fileViewer = true;',
      }),
    }),
  );
  await page.goto(`${localOrigin}/sessions/external-links-session`);
  const markdownLink = page.getByRole('link', { name: 'Markdown external' });
  await expect(markdownLink).toBeVisible();
  const popup = page
    .waitForEvent('popup', { timeout: 500 })
    .catch(() => undefined);
  await markdownLink.click();
  expect(await popup).toBeUndefined();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]?.input).toMatchObject({
    url: 'https://example.com/markdown',
  });

  const usageLink = page.getByRole('link', { name: 'View usage in ChatGPT' });
  await expect(usageLink).toBeVisible();
  await usageLink.evaluate((anchor) => {
    anchor.id = 'usage';
  });
  await usageLink.press('Enter');
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]?.input).toMatchObject({
    url: 'https://chatgpt.com/settings/usage',
  });
  const transcriptLink = (name: string) =>
    page
      .locator('.message-assistant .markdown')
      .getByRole('link', { name, exact: true });
  const downloadLink = transcriptLink('Download');
  await downloadLink.evaluate((anchor) =>
    anchor.setAttribute('download', 'test.txt'),
  );
  const preventedLink = transcriptLink('Prevented');
  await preventedLink.evaluate((anchor) =>
    anchor.addEventListener('click', (event) => event.preventDefault(), {
      once: true,
    }),
  );
  await transcriptLink('Modified').click({ modifiers: ['Control'] });
  await transcriptLink('Middle').click({ button: 'middle' });
  expect(requests).toHaveLength(2);
  const preventedPopup = page
    .waitForEvent('popup', { timeout: 300 })
    .catch(() => undefined);
  await preventedLink.click();
  expect(await preventedPopup).toBeUndefined();
  const downloadEvent = page.waitForEvent('download');
  await downloadLink.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('test.txt');
  const internalLink = transcriptLink('Internal');
  await internalLink.evaluate((anchor) => anchor.removeAttribute('target'));
  await internalLink.click();
  await expect(page).toHaveURL(/\/sessions\/external-links-session$/);
  expect(requests).toHaveLength(2);
  await transcriptLink('File').click();
  const fileViewer = page.getByRole('dialog').last();
  await expect(fileViewer).toBeVisible();
  await expect(fileViewer).toContainText('export const fileViewer = true;');
  expect(requests).toHaveLength(2);
  await fileViewer.getByRole('button', { name: 'Close file viewer' }).click();

  openResult = { opened: false };
  await markdownLink.click();
  await expect.poll(() => requests.length).toBe(3);
  const fallback = page
    .getByRole('alert')
    .getByRole('link', { name: 'Open link in Chrome' });
  await expect(fallback).toHaveAttribute(
    'href',
    'https://example.com/markdown',
  );
  await expect(fallback).toHaveAttribute('target', '_blank');
  const fallbackPopupEvent = page.waitForEvent('popup');
  await fallback.click();
  const fallbackPopup = await fallbackPopupEvent;
  await expect(fallbackPopup).toHaveURL('https://example.com/markdown');
  expect(requests).toHaveLength(3);
  await fallbackPopup.close();

  const discoveryCount = statusRequests;
  await page.goto(
    `${testOrigin.replace('127.0.0.1', 'localhost')}/sessions/external-links-session`,
  );
  const browserLink = page.getByRole('link', { name: 'Markdown external' });
  const browserPopup = page.waitForEvent('popup');
  await browserLink.click();
  const popupPage = await browserPopup;
  await expect(popupPage).toHaveURL('https://example.com/markdown');
  expect(statusRequests).toBe(discoveryCount);
  expect(requests).toHaveLength(3);
  await popupPage.close();

  helperAvailable = false;
  const beforeUnavailableDiscovery = statusRequests;
  await page.goto(`${localOrigin}/sessions/external-links-session`);
  await expect
    .poll(() => statusRequests)
    .toBeGreaterThan(beforeUnavailableDiscovery);
  const unavailableLink = page.getByRole('link', { name: 'Markdown external' });
  const unavailablePopupEvent = page.waitForEvent('popup');
  await unavailableLink.click();
  const unavailablePopup = await unavailablePopupEvent;
  await expect(unavailablePopup).toHaveURL('https://example.com/markdown');
  expect(requests).toHaveLength(3);
  await unavailablePopup.close();
});
