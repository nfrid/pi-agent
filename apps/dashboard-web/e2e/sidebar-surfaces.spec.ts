import { expect, type Page, test } from '@playwright/test';
import {
  buildActivityPanelScenario,
  installVisualStateScenario,
} from './visual-state-fixtures';

async function openSession(page: Page, manyDelegates = false) {
  await page.setViewportSize({ width: 393, height: 851 });
  const scenario = buildActivityPanelScenario(true);
  const active = scenario.sessionSnapshot?.active;
  const source = active?.delegates[0];
  if (manyDelegates && active && source) {
    active.delegates = Array.from({ length: 50 }, (_, index) => ({
      ...source,
      runId: `drawer-run-${index}`,
      lineageId: `drawer-lineage-${index}`,
      name: `Drawer worker ${index + 1}`,
    }));
  }
  await installVisualStateScenario(page, scenario);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible();
}

async function swipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [from],
  });
  for (let step = 1; step <= 5; step++) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * step) / 5,
          y: from.y + ((to.y - from.y) * step) / 5,
        },
      ],
    });
  }
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await touch.detach();
}

for (const side of ['activity', 'threads'] as const) {
  test(`${side} sidebar animates, has a dismissible curtain, and closes with native swipe`, async ({
    page,
  }) => {
    await openSession(page);
    const opener = page.getByRole('button', {
      name: side === 'activity' ? 'Open session activity' : 'Open agent list',
      exact: true,
    });
    const panel = page.locator(
      side === 'activity' ? '.activity-panel' : '.agent-nav-drawer',
    );
    await opener.tap();
    await expect(panel).toBeVisible();
    await expect
      .poll(() =>
        panel.evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            style.animationName !== 'none' &&
            parseFloat(style.animationDuration) > 0
          );
        }),
      )
      .toBe(true);
    await expect(panel).toBeInViewport();
    await expect(page).toHaveScreenshot(`mobile-${side}-curtain.png`, {
      animations: 'disabled',
    });
    await page.touchscreen.tap(side === 'activity' ? 15 : 380, 430);
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.tap();
    await expect
      .poll(() =>
        panel.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right) };
        }),
      )
      .toMatchObject(side === 'activity' ? { right: 393 } : { left: 0 });
    await swipe(
      page,
      { x: side === 'activity' ? 170 : 220, y: 28 },
      { x: side === 'activity' ? 315 : 75, y: 31 },
    );
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
    await swipe(
      page,
      { x: side === 'activity' ? 385 : 8, y: 430 },
      { x: side === 'activity' ? 275 : 120, y: 433 },
    );
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });
}

test('activity vertical scroll and nested inspector dismissal leave the parent open', async ({
  page,
}) => {
  await openSession(page, true);
  await page.getByRole('button', { name: 'Open session activity' }).tap();
  const panel = page.locator('.activity-panel');
  await expect(panel).toBeVisible();
  const content = panel;
  await swipe(page, { x: 200, y: 650 }, { x: 202, y: 330 });
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(panel).toBeVisible();
  await content.evaluate((element) => {
    element.scrollTop = 0;
  });
  await panel.locator('.delegate-row-toggle').first().click();
  const inspector = page.getByRole('dialog', {
    name: /Delegate · Drawer worker 1/,
  });
  await expect(inspector).toBeVisible();
  const inspectorBox = await inspector.boundingBox();
  if (!inspectorBox) throw new Error('Missing inspector bounds');
  await swipe(
    page,
    { x: 150, y: inspectorBox.y + 24 },
    { x: 310, y: inspectorBox.y + 26 },
  );
  await expect(inspector).toHaveCount(0);
  await expect(panel).toBeVisible();
  await panel.locator('.delegate-row-toggle').first().click();
  await expect(inspector).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect(panel).toBeVisible();
  const rowBox = await panel
    .locator('.delegate-row-toggle')
    .first()
    .boundingBox();
  if (!rowBox) throw new Error('Missing delegate row bounds');
  await swipe(
    page,
    { x: 160, y: rowBox.y + rowBox.height / 2 },
    { x: 315, y: rowBox.y + rowBox.height / 2 + 2 },
  );
  await expect(panel).toHaveCount(0);
  await expect(inspector).toHaveCount(0);
});

test('rapid activity reopen cancels exit cleanup and reduced motion remains dismissible', async ({
  page,
}) => {
  await openSession(page);
  const opener = page.getByRole('button', { name: 'Open session activity' });
  const panel = page.locator('.activity-panel');
  await opener.tap();
  await expect(panel).toBeVisible();
  // Reopen the same DOM during an actual exit frame, before presence cleanup.
  const exit = await panel.evaluate(async (element) => {
    element.setAttribute('data-reopen-probe', 'retained');
    const width = element.getBoundingClientRect().width;
    element
      .querySelector<HTMLButtonElement>('[aria-label="Close activity panel"]')
      ?.click();
    await new Promise(requestAnimationFrame);
    const layer = element.closest('.side-panel-layer');
    const result = {
      exiting: layer?.classList.contains('is-exiting'),
      width: element.getBoundingClientRect().width,
      originalWidth: width,
      animation: getComputedStyle(element).animationName,
    };
    document
      .querySelector<HTMLButtonElement>('.session-activity-button')
      ?.click();
    return result;
  });
  expect(exit.exiting).toBe(true);
  expect(exit.width).toBe(exit.originalWidth);
  expect(exit.animation).toBe('side-panel-right-out');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-reopen-probe', 'retained');
  await expect(panel).not.toHaveClass(/is-exiting/);
  await panel.getByText('Tasks', { exact: true }).click();
  await expect(
    panel.getByRole('button', { name: 'Show fewer tasks' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await opener.tap();
  await expect(panel).toBeVisible();
  await page.touchscreen.tap(15, 430);
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('@desktop responsive sidebars return inline without trapping the session', async ({
  page,
}) => {
  await openSession(page);
  await page.getByRole('button', { name: 'Open session activity' }).click();
  await expect(page.locator('.side-panel-layer')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('.side-panel-layer')).toHaveCount(0);
  await expect(page.locator('.activity-panel.is-pinned')).toBeVisible();
  await expect(page.locator('.session-heading-actions')).toBeInViewport();
  const heading = await page.locator('.session-heading-actions').boundingBox();
  if (!heading) throw new Error('Missing desktop session heading');
  expect(heading.y).toBeLessThan(60);
  await page.getByRole('button', { name: 'Unpin activity panel' }).click();
  await expect(page.locator('.activity-panel.is-pinned')).toHaveCount(0);
  await expect(page.locator('.session-heading-actions')).toBeInViewport();
  await page.setViewportSize({ width: 393, height: 851 });
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await expect(page.locator('.side-panel-left')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('.side-panel-layer')).toHaveCount(0);
  await expect(page.locator('.agent-thread-nav-session')).toBeVisible();
  await expect(page.locator('.session-heading-actions')).toBeInViewport();
});
