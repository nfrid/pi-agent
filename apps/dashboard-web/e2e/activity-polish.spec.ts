import { expect, test } from '@playwright/test';
import {
  buildActivityPanelScenario,
  installVisualStateScenario,
} from './visual-state-fixtures';

const PIN_KEY = 'pi-dashboard-activity-panel-pinned-v1';

type SimulatedWcoGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function simulateWco(
  page: import('@playwright/test').Page,
  values: SimulatedWcoGeometry,
) {
  await page.evaluate((values) => {
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
    document.querySelector('[data-wco-native-controls]')?.remove();
    const nativeControls = document.createElement('div');
    nativeControls.dataset.wcoNativeControls = '';
    nativeControls.textContent = 'Window controls';
    nativeControls.style.cssText = `position:fixed;left:${values.x + values.width}px;top:${values.y}px;width:${window.innerWidth - values.x - values.width}px;height:${values.height}px;z-index:1000;background:#252733;color:#aaa;font:10px sans-serif;display:grid;place-items:center`;
    document.body.append(nativeControls);
  }, values);
}

async function headerGeometry(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const leftHeader = document.querySelector('.agent-thread-nav > div');
    const activityHeader = document.querySelector('.activity-panel-bar');
    const activityHeading = document.querySelector(
      '.activity-panel-bar strong',
    );
    const pin = document.querySelector('.activity-panel-pin');
    const sessionActions = document.querySelector('.session-heading-actions');
    const panel = document.querySelector('.activity-panel');
    const nativeControls = document.querySelector('[data-wco-native-controls]');
    if (
      !leftHeader ||
      !activityHeader ||
      !activityHeading ||
      !pin ||
      !sessionActions ||
      !panel ||
      !nativeControls
    )
      throw new Error('WCO header geometry missing');
    const effectiveHeight = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.height + Number.parseFloat(getComputedStyle(element).marginBottom)
      );
    };
    return {
      leftHeight: effectiveHeight(leftHeader),
      activityHeight: effectiveHeight(activityHeader),
      activityHeading: activityHeading.getBoundingClientRect().toJSON(),
      pin: pin.getBoundingClientRect().toJSON(),
      sessionActions: sessionActions.getBoundingClientRect().toJSON(),
      panel: panel.getBoundingClientRect().toJSON(),
      nativeControls: nativeControls.getBoundingClientRect().toJSON(),
    };
  });
}

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
    await panel.getByText('Tasks', { exact: true }).click();
    await expect(
      panel.getByText('Deploy client bundle', { exact: false }),
    ).toBeVisible();
    await panel.getByText('Delegates', { exact: true }).click();
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
  // Keep conventional chrome as a baseline, then exercise the shipped WCO
  // rules with CSSOM media/env substitutions rather than an approximation.
  const conventionalHeight = await page
    .locator('.activity-panel-bar')
    .evaluate((element) => element.getBoundingClientRect().height);
  const fullWco = { x: 82, y: 0, width: 1240, height: 40 };
  await simulateWco(page, fullWco);
  const pin = page.getByRole('button', { name: 'Unpin activity panel' });
  const expandedGeometry = await headerGeometry(page);
  expect(expandedGeometry.activityHeight).toBe(expandedGeometry.leftHeight);
  expect(conventionalHeight).toBeLessThanOrEqual(50);
  expect(expandedGeometry.activityHeading.right).toBeLessThanOrEqual(
    expandedGeometry.pin.left,
  );
  expect(expandedGeometry.pin.right).toBeLessThanOrEqual(
    expandedGeometry.nativeControls.left,
  );
  expect(expandedGeometry.sessionActions.right).toBeLessThanOrEqual(
    expandedGeometry.panel.left,
  );
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
  const collapsedActions = await page
    .locator('.session-heading-actions')
    .boundingBox();
  if (!collapsedActions) throw new Error('collapsed session actions missing');
  expect(collapsedActions.x + collapsedActions.width).toBeLessThanOrEqual(1322);

  const smallerWco = { x: 160, y: 0, width: 1160, height: 32 };
  await page.evaluate((key) => localStorage.setItem(key, 'true'), PIN_KEY);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Unpin activity panel' }),
  ).toBeVisible();
  await simulateWco(page, smallerWco);
  const smallerExpanded = await headerGeometry(page);
  expect(smallerExpanded.activityHeight).toBe(smallerExpanded.leftHeight);
  expect(smallerExpanded.activityHeading.right).toBeLessThanOrEqual(
    smallerExpanded.pin.left,
  );
  expect(smallerExpanded.pin.right).toBeLessThanOrEqual(
    smallerExpanded.nativeControls.left,
  );
  expect(smallerExpanded.sessionActions.right).toBeLessThanOrEqual(
    smallerExpanded.panel.left,
  );
  await page.getByRole('button', { name: 'Unpin activity panel' }).click();
  await expect(page.locator('.activity-panel.is-pinned')).toHaveCount(0);
  const smallerCollapsed = await page
    .locator('.session-heading-actions')
    .boundingBox();
  if (!smallerCollapsed)
    throw new Error('smaller collapsed session actions missing');
  expect(smallerCollapsed.x + smallerCollapsed.width).toBeLessThanOrEqual(
    smallerWco.x + smallerWco.width,
  );
});
