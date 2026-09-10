import { expect, test } from '@playwright/test';
import {
  buildActivityPanelScenario,
  installVisualStateScenario,
} from './visual-state-fixtures';

for (const active of [false, true]) {
  test(`activity panel stays compact with ${active ? 'active' : 'completed'} work @desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installVisualStateScenario(page, buildActivityPanelScenario(active));
    const panel = page.locator('.activity-panel');
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole('region', { name: 'Tasks', exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole('region', { name: 'Delegates', exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText('Current checkout', { exact: false }),
    ).toHaveCount(0);
    await expect(panel).not.toContainText('NORMAL');
    if (active) {
      const name = panel.getByText('Activity panel visual refinement', {
        exact: true,
      });
      await expect(name).toBeVisible();
      expect(
        await name.evaluate(
          (element) => getComputedStyle(element).textOverflow,
        ),
      ).not.toBe('ellipsis');
      const queue = await page.locator('.queue-panel').boundingBox();
      const composer = await page.locator('form.composer').boundingBox();
      if (!queue || !composer) throw new Error('queue/composer missing');
      expect(Math.abs(queue.x - composer.x)).toBeLessThan(1);
      expect(Math.abs(queue.width - composer.width)).toBeLessThan(1);
    }
    await expect(panel).toHaveScreenshot(
      `activity-${active ? 'active' : 'completed'}.png`,
      { animations: 'disabled' },
    );
    await panel
      .getByRole('button', { name: `Show all ${active ? 5 : 3} tasks` })
      .click();
    await expect(
      panel.getByText('Deploy client bundle', { exact: false }),
    ).toBeVisible();
    await panel
      .getByRole('button', { name: `${active ? 5 : 6} finished` })
      .click();
    await expect(
      panel.getByText('Finished worker 6', { exact: true }),
    ).toBeVisible();
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    if (!active)
      await expect(panel).toHaveScreenshot('activity-completed-expanded.png', {
        animations: 'disabled',
      });
  });
}

test('queued messages share mobile composer gutters', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 851 });
  await installVisualStateScenario(page, buildActivityPanelScenario(true));
  await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible();
  const queue = await page.locator('.queue-panel').boundingBox();
  const composer = await page.locator('form.composer').boundingBox();
  if (!queue || !composer) throw new Error('queue/composer missing');
  expect(Math.abs(queue.x - composer.x)).toBeLessThan(1);
  expect(Math.abs(queue.width - composer.width)).toBeLessThan(1);
  await expect(page).toHaveScreenshot('queue-composer-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});

test('mobile right edge opens activity with native touch input during viewport updates', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 851 });
  await installVisualStateScenario(page, buildActivityPanelScenario(true));
  await expect(
    page.getByRole('button', { name: 'Open session activity' }),
  ).toBeVisible();
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 385, y: 430 }],
  });
  // Session state can change while a finger is down (streaming/scroll state).
  await page
    .locator('.session-transcript-scroll')
    .evaluate((element) =>
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })),
    );
  for (const x of [365, 340, 310, 275])
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 433 }],
    });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(page.locator('.activity-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Close activity panel' }).click();
  // A predominantly vertical edge gesture must not open the drawer.
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 385, y: 430 }],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 380, y: 530 }],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(page.locator('.activity-panel')).toHaveCount(0);
});

test('activity header clears simulated PWA window controls @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installVisualStateScenario(page, buildActivityPanelScenario(false));
  // Chromium cannot emulate display-mode:window-controls-overlay via CDP.
  // Exercise the shipped rules with only media/env inputs substituted, not
  // a separately maintained approximation of the header styling.
  await page.evaluate(() => {
    const values: Record<string, number> = {
      x: 82,
      y: 0,
      width: 1240,
      height: 40,
    };
    const apply = (rules: CSSRuleList, overlay = false) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSImportRule && rule.styleSheet)
          apply(rule.styleSheet.cssRules, overlay);
        if (rule instanceof CSSMediaRule) {
          const isOverlay = rule.conditionText.includes(
            'display-mode: window-controls-overlay',
          );
          if (isOverlay) rule.media.mediaText = 'all';
          apply(rule.cssRules, overlay || isOverlay);
        }
        if (overlay && rule instanceof CSSStyleRule) {
          for (const property of Array.from(rule.style)) {
            const value = rule.style
              .getPropertyValue(property)
              .replace(
                /env\(titlebar-area-(x|y|width|height)(?:,[^)]*)?\)/g,
                (_, dimension: string) => `${values[dimension]}px`,
              );
            rule.style.setProperty(
              property,
              value,
              rule.style.getPropertyPriority(property),
            );
          }
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) apply(sheet.cssRules);
    const nativeControls = document.createElement('div');
    nativeControls.textContent = 'Window controls';
    nativeControls.style.cssText =
      'position:fixed;right:0;top:0;width:118px;height:40px;z-index:1000;background:#252733;color:#aaa;font:10px sans-serif;display:grid;place-items:center';
    document.body.append(nativeControls);
  });
  const pin = page.getByRole('button', { name: 'Unpin activity panel' });
  const pinBox = await pin.boundingBox();
  if (!pinBox) throw new Error('pin missing');
  expect(pinBox.x + pinBox.width).toBeLessThanOrEqual(1322);
  await expect(page.locator('.activity-panel-bar')).toHaveCSS(
    '-webkit-app-region',
    'drag',
  );
  await expect(pin).toHaveCSS('-webkit-app-region', 'no-drag');
  await expect(page).toHaveScreenshot('activity-pwa-titlebar-simulated.png', {
    animations: 'disabled',
    clip: { x: 0, y: 0, width: 1440, height: 180 },
  });
  await pin.click();
  await expect(page.locator('.activity-panel.is-pinned')).toHaveCount(0);
});
