import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { expect, type Page, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const session = {
  id: 'activity-layout-session',
  file: '',
  cwd: '/workspace/project',
  title: 'Activity layout',
  updatedAt: 1,
};
const snapshot = {
  serverId: 'activity-layout-server',
  revision: 1,
  cursor: 1,
  runtimes: [],
  projects: [],
  checkouts: [],
  sessions: [session],
  unread: [],
} as unknown as BrowserSnapshot;

async function openSession(page: Page) {
  await installDashboardBootstrap(page, snapshot);
  await page.goto('/sessions/activity-layout-session');
  await expect(page.locator('.session-transcript-scroll')).toBeVisible();
}

test('desktop session keeps a full-width scrollport and pinned activity rail @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSession(page);
  const geometry = await page.evaluate(() => {
    const scroll = document.querySelector('.session-transcript-scroll');
    const transcript = document.querySelector('.transcript');
    const composer = document.querySelector('.composer');
    const panel = document.querySelector('.activity-panel');
    if (!scroll || !transcript || !composer || !panel)
      throw new Error('layout missing');
    return {
      scroll: scroll.getBoundingClientRect(),
      transcript: transcript.getBoundingClientRect(),
      composer: composer.getBoundingClientRect(),
      panel: panel.getBoundingClientRect(),
      reserve: getComputedStyle(scroll).paddingBottom,
    };
  });
  expect(
    Math.abs(geometry.scroll.width - geometry.transcript.width),
  ).toBeLessThanOrEqual(1);
  expect(geometry.composer.width).toBeLessThan(geometry.scroll.width);
  expect(geometry.panel.width).toBeGreaterThan(200);
  expect(Number.parseFloat(geometry.reserve)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Unpin activity panel' }).click();
  await expect(page.locator('.activity-panel')).not.toHaveClass(/is-open/);
  await page.getByRole('button', { name: 'Open session activity' }).click();
  await expect(page.locator('.activity-panel')).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.activity-panel')).not.toHaveClass(/is-open/);
});

test('mobile activity button opens and dismisses the right overlay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSession(page);
  const trigger = page.getByRole('button', { name: 'Open session activity' });
  await expect(trigger).toHaveCSS('width', '34px');
  await trigger.click();
  await expect(page.locator('.activity-panel')).toHaveClass(/is-open/);
  await page.mouse.click(12, 400);
  await expect(page.locator('.activity-panel')).not.toHaveClass(/is-open/);
  await page.evaluate(() => {
    const start = new Touch({
      identifier: 1,
      target: document.body,
      clientX: window.innerWidth - 4,
      clientY: 400,
    });
    const end = new Touch({
      identifier: 1,
      target: document.body,
      clientX: window.innerWidth - 100,
      clientY: 400,
    });
    window.dispatchEvent(
      new TouchEvent('touchstart', { changedTouches: [start] }),
    );
    window.dispatchEvent(new TouchEvent('touchend', { changedTouches: [end] }));
  });
  await expect(page.locator('.activity-panel')).toHaveClass(/is-open/);
});
