import { expect, test } from '@playwright/test';
import {
  buildEmptyHomeScenario,
  buildFailedScenario,
  buildOfflineScenario,
  buildWaitingScenario,
  buildWorkingScenario,
  installVisualStateScenario,
  VISUAL_DESKTOP_VIEWPORT,
  VISUAL_PIXEL_VIEWPORT,
} from './visual-state-fixtures';

test('empty home is ready for a new thread @desktop', async ({ page }) => {
  await page.setViewportSize(VISUAL_DESKTOP_VIEWPORT);
  await installVisualStateScenario(page, buildEmptyHomeScenario());

  await expect(
    page.getByRole('heading', { name: 'Pick a thread to continue' }),
  ).toBeVisible();
  await expect(
    page.locator('.empty-workspace-actions').getByRole('button', {
      name: 'New thread',
    }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot('empty-home-desktop.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});

test('working transcript shows flat tools, tasks, and delegates @desktop', async ({
  page,
}) => {
  await page.setViewportSize(VISUAL_DESKTOP_VIEWPORT);
  await installVisualStateScenario(page, buildWorkingScenario());

  await expect(page.locator('.session-status')).toContainText('working');
  await expect(
    page.getByText('Inspecting the dashboard surfaces.', { exact: true }),
  ).toBeVisible();
  const earlierCalls = page.getByRole('button', {
    name: /Show 2 earlier calls/,
  });
  await expect(earlierCalls).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.tool-stream-items .tool-detail')).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: /Tasks 0 of 2 tasks complete/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Current tasks and delegates' }),
  ).toBeVisible();
  await expect(page.getByText('Review worker', { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot('working-transcript-desktop.png', {
    animations: 'disabled',
    caret: 'hide',
  });

  await earlierCalls.click();
  await expect(
    page.getByRole('button', { name: /Hide 2 earlier calls/ }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.tool-stream-items .tool-detail')).toHaveCount(5);
  await expect(page).toHaveScreenshot(
    'working-transcript-expanded-desktop.png',
    {
      animations: 'disabled',
      caret: 'hide',
    },
  );
});

test('working transcript keeps run status compact on Pixel', async ({
  page,
}) => {
  await page.setViewportSize(VISUAL_PIXEL_VIEWPORT);
  await installVisualStateScenario(page, buildWorkingScenario());

  const runStatus = page.getByRole('button', { name: /Run status/ });
  await expect(runStatus).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('button', { name: /Tasks 0 of 2 tasks complete/ }),
  ).not.toBeVisible();
  await expect(page).toHaveScreenshot('working-transcript-pixel.png', {
    animations: 'disabled',
    caret: 'hide',
  });

  await runStatus.click();
  await expect(runStatus).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('button', { name: /Tasks 0 of 2 tasks complete/ }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot('working-run-status-expanded-pixel.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});

test('waiting thread presents an actionable waiting state @desktop', async ({
  page,
}) => {
  await page.setViewportSize(VISUAL_DESKTOP_VIEWPORT);
  await installVisualStateScenario(page, buildWaitingScenario());

  await expect(page.locator('.session-status')).toContainText('waiting');
  await expect(
    page.getByText('The checklist is ready for your review.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot('waiting-thread-desktop.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});

test('failed thread preserves the diagnostic state @desktop', async ({
  page,
}) => {
  await page.setViewportSize(VISUAL_DESKTOP_VIEWPORT);
  await installVisualStateScenario(page, buildFailedScenario());

  await expect(page.locator('.session-status')).toContainText('failed');
  const failedTool = page
    .locator('.tool-detail.step-failed')
    .filter({ hasText: 'bun test' })
    .first();
  await expect(failedTool).toBeVisible();
  await expect(failedTool.getByText('bun test', { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot('failed-thread-desktop.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});

test('offline thread drawer and command palette fit a Pixel viewport', async ({
  page,
}) => {
  await page.setViewportSize(VISUAL_PIXEL_VIEWPORT);
  await installVisualStateScenario(page, buildOfflineScenario());

  await expect(page.locator('.session-status')).toContainText('offline');
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const drawer = page.locator('.agent-nav-drawer.open');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Offline diagnostics');
  await expect(page).toHaveScreenshot('offline-thread-drawer-pixel.png', {
    animations: 'disabled',
    caret: 'hide',
  });

  await page.locator('.agent-nav-backdrop').click();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await expect(
    palette.getByRole('combobox', {
      name: 'Search commands, threads, and projects',
    }),
  ).toBeFocused();
  await expect(page).toHaveScreenshot('command-palette-pixel.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});
