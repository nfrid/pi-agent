import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  buildWorkingScenario,
  installVisualStateScenario,
} from './visual-state-fixtures';

const PIN_KEY = 'pi-dashboard-activity-panel-pinned-v1';

async function openWorkingSession(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((key) => localStorage.removeItem(key), PIN_KEY);
  const base = buildWorkingScenario();
  const sessionSnapshot = base.sessionSnapshot;
  if (!sessionSnapshot) throw new Error('working scenario has no session');
  const entries = Array.from({ length: 100 }, (_, index) => ({
    type: 'message',
    id: `layout-message-${index}`,
    message: {
      role: index % 2 ? 'assistant' : 'user',
      timestamp: Date.now() - (100 - index) * 1_000,
      content: [
        {
          type: 'text',
          text: `Layout reading fixture message ${index + 1}.`,
        },
      ],
    },
  }));
  await installVisualStateScenario(page, {
    ...base,
    sessionSnapshot: { ...sessionSnapshot, entries },
  });
  await expect(page.locator('.session-transcript-scroll')).toBeVisible();
  await expect(page.locator('.transcript-virtual-row').last()).toBeVisible();
}

test('wide session reserves activity rail, preserves reading gutters, and reopens after unpin @desktop', async ({
  page,
}) => {
  await openWorkingSession(page, 1440, 900);
  const layout = await page.evaluate(() => {
    const root = document.querySelector('.session-layout');
    const scroll = document.querySelector('.session-transcript-scroll');
    const row = document.querySelector('.transcript-virtual-row');
    const composer = document.querySelector('.composer');
    const panel = document.querySelector('.activity-panel');
    if (!root || !scroll || !row || !composer || !panel)
      throw new Error('populated session layout missing');
    const rootStyle = getComputedStyle(root);
    const scrollRect = scroll.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      columns: rootStyle.gridTemplateColumns,
      scroll: scrollRect,
      row: rowRect,
      composer: composerRect,
      panel: panelRect,
      reserve: Number.parseFloat(getComputedStyle(scroll).paddingBottom),
    };
  });
  expect(layout.columns.split(' ').length).toBe(3);
  expect(layout.panel.width).toBeGreaterThanOrEqual(290);
  expect(layout.row.width).toBeLessThan(layout.scroll.width - 40);
  expect(layout.row.left).toBeGreaterThan(layout.scroll.left + 20);
  expect(layout.row.right).toBeLessThan(layout.scroll.right - 20);
  expect(layout.composer.width).toBeLessThan(layout.scroll.width);
  expect(layout.reserve).toBeGreaterThan(0);

  const lastRow = page.locator('.transcript-virtual-row').last();
  await expect
    .poll(async () =>
      lastRow.evaluate((row) => {
        const composer = document.querySelector('.composer');
        if (!composer) return Number.POSITIVE_INFINITY;
        return (
          composer.getBoundingClientRect().top -
          row.getBoundingClientRect().bottom
        );
      }),
    )
    .toBeGreaterThanOrEqual(0);

  const composerInput = page.getByRole('textbox').first();
  const before = await page
    .locator('.session-transcript-scroll')
    .evaluate((element) => getComputedStyle(element).paddingBottom);
  await composerInput.fill(
    'line one\nline two\nline three\nline four\nline five',
  );
  await expect
    .poll(() =>
      page
        .locator('.session-transcript-scroll')
        .evaluate((element) => getComputedStyle(element).paddingBottom),
    )
    .not.toBe(before);

  await page.getByRole('button', { name: 'Unpin activity panel' }).click();
  await expect(page.locator('.activity-panel.is-open')).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator('.session-layout')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns),
    )
    .not.toContain('300px');
  await page.getByRole('button', { name: 'Open session activity' }).click();
  await expect(page.locator('.activity-panel')).toHaveClass(/is-open/);
  await expect(
    page.getByRole('button', { name: 'Close activity panel' }),
  ).toBeVisible();
  const delegate = page.getByRole('button', { name: /Review worker/ }).last();
  await expect(delegate).toBeVisible();
  await delegate.click();
  const activePortal = page.locator('[data-surface-portal-root]');
  const hasVisiblePortal = await activePortal.evaluateAll((nodes) =>
    nodes.some((node) => {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      return (
        element.getClientRects().length > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    }),
  );
  if (hasVisiblePortal) {
    await page.keyboard.press('Escape');
    await expect(page.locator('.activity-panel.is-open')).toHaveCount(1);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.activity-panel.is-open')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.activity-panel.is-open')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open session activity' }).click();
  await expect(page.locator('.activity-panel')).toHaveClass(/is-open/);
});

test('mobile uses header activity button, close action, and right-edge gesture without a mid-edge handle', async ({
  page,
}) => {
  await openWorkingSession(page, 390, 844);
  await expect(page.locator('.agent-nav-handle')).toHaveCount(0);
  const activityButton = page.getByRole('button', {
    name: 'Open session activity',
  });
  await expect(activityButton).toBeVisible();
  await activityButton.click();
  await expect(page.locator('.activity-panel')).toHaveClass(/is-open/);
  await expect(
    page.getByRole('button', { name: 'Close activity panel' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Unpin activity panel' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Close activity panel' }).click();
  await expect(page.locator('.activity-panel.is-open')).toHaveCount(0);

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
  await page.mouse.click(12, 400);
  await expect(page.locator('.activity-panel.is-open')).toHaveCount(0);
});
