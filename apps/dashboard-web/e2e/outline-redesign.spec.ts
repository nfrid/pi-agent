import { expect, type Page, test } from '@playwright/test';
import {
  buildWorkingScenario,
  installVisualStateScenario,
  VISUAL_TIMESTAMP,
} from './visual-state-fixtures';

type SimulatedWcoGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function simulateWco(page: Page, values: SimulatedWcoGeometry) {
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
  }, values);
}

async function openTurns(page: Page, count: number, repliesPerTurn = 1) {
  const base = buildWorkingScenario();
  if (!base.sessionSnapshot) throw new Error('Missing transcript fixture');
  const entries = Array.from({ length: count }, (_, index) => [
    {
      type: 'message',
      id: `prompt-${index}`,
      message: {
        role: 'user',
        timestamp: VISUAL_TIMESTAMP + index * 1000,
        content: [
          {
            type: 'text',
            text: `User prompt ${String(index + 1).padStart(3, '0')}: inspect the layout`,
          },
        ],
      },
    },
    ...Array.from({ length: repliesPerTurn }, (_, reply) => ({
      type: 'message',
      id: `reply-${index}-${reply}`,
      message: {
        role: 'assistant',
        timestamp: VISUAL_TIMESTAMP + index * 1000 + 500,
        content: [
          {
            type: 'text',
            text: `Assistant response ${index + 1}. Ordinary progress should not become an outline anchor.`,
          },
        ],
      },
    })),
  ]).flat();
  await installVisualStateScenario(page, {
    ...base,
    sessionSnapshot: { ...base.sessionSnapshot, entries },
  });
  await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible();
  await expect(
    page.locator('.transcript-virtual-row, .transcript article').last(),
  ).toBeVisible();
}

test('dense outline stays bounded, never scrolls on hover and searches every turn @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await openTurns(page, 300);
  const rail = page.locator('.transcript-minimap');
  const scroll = page.locator('.session-transcript-scroll');
  await expect(rail).toBeVisible();
  await expect(rail.getByText('Outline', { exact: true })).toHaveCount(0);
  const markers = rail.locator('.transcript-minimap-marker');
  expect(await markers.count()).toBeGreaterThan(1);
  expect(await markers.count()).toBeLessThan(300);
  await expect(
    page.locator('.transcript-minimap-marker[aria-current="location"]'),
  ).toHaveCount(1);
  const bounds = await markers.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }),
  );
  for (let index = 1; index < bounds.length; index++) {
    const current = bounds[index];
    const previous = bounds[index - 1];
    if (!current || !previous) throw new Error('Missing marker bounds');
    expect(current.top).toBeGreaterThanOrEqual(previous.bottom - 1);
  }
  const railBox = await rail.boundingBox();
  const scrollBox = await scroll.boundingBox();
  if (!railBox || !scrollBox) throw new Error('Missing outline geometry');
  expect(railBox.height).toBeLessThan(scrollBox.height);
  const before = await scroll.evaluate((element) => element.scrollTop);
  const tick = markers.first().locator('i');
  const restingWidth = (await tick.boundingBox())?.width;
  if (restingWidth === undefined) throw new Error('Missing resting tick');
  await markers.first().hover();
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBe(before);
  await expect
    .poll(async () => (await tick.boundingBox())?.width ?? 0)
    .toBeGreaterThan(restingWidth);
  await page
    .getByRole('button', { name: 'Open transcript outline', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Transcript outline',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole('searchbox');
  await expect(search).toBeFocused();
  await expect(dialog.locator('.transcript-outline-jump')).toHaveCount(300);
  await expect(dialog.locator('.transcript-outline-list')).not.toContainText(
    'Assistant response',
  );
  await search.fill('User prompt 001');
  await expect(dialog.locator('.transcript-outline-jump')).toHaveCount(1);
  await search.press('ArrowDown');
  await expect(dialog.locator('.transcript-outline-jump')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator('.message-user').filter({ hasText: 'User prompt 001' }),
  ).toBeVisible();
  await expect(markers.first()).toHaveAttribute('aria-current', 'location');
  await expect(scroll).toHaveScreenshot('quiet-outline-first-turn.png', {
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Open transcript outline', exact: true })
    .first()
    .click();
  await search.fill('User prompt 300');
  await expect(dialog.locator('.transcript-outline-jump')).toHaveCount(1);
  const searchBox = await dialog.boundingBox();
  if (!searchBox) throw new Error('Missing search panel geometry');
  expect(searchBox.height).toBeLessThan(240);
  expect(searchBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
  await expect(dialog).toHaveScreenshot('searchable-turn-outline.png', {
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page
      .getByRole('button', { name: 'Open transcript outline', exact: true })
      .first(),
  ).toBeFocused();
});

test('23 desktop turns retain individual compact rail markers @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await openTurns(page, 23);
  const markers = page.locator('.transcript-minimap-marker');
  await expect(markers).toHaveCount(23);
  expect(
    await markers.evaluateAll((elements) =>
      elements.every((element) => element.dataset.clusterSize === '1'),
    ),
  ).toBe(true);
  const bounds = await markers.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect()),
  );
  for (let index = 1; index < bounds.length; index++) {
    const current = bounds[index];
    const previous = bounds[index - 1];
    if (!current || !previous) throw new Error('Missing marker bounds');
    expect(current.top - previous.top).toBe(8);
  }
});

test('outline popup avoids PWA titlebar clearance while other surfaces retain it @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTurns(page, 23);
  await page
    .getByRole('button', { name: 'Open transcript outline', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Transcript outline',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const outlineHeader = dialog.locator('.surface-drawer-header');
  await simulateWco(page, { x: 82, y: 0, width: 1240, height: 40 });
  await expect(outlineHeader).toHaveCSS('min-height', '0px');
  await expect(outlineHeader).toHaveCSS('padding-top', '16px');
  await expect(outlineHeader).toHaveCSS('padding-bottom', '13px');
  await expect(
    outlineHeader.getByRole('button', { name: 'Close Transcript outline' }),
  ).toHaveCSS('margin-right', '0px');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  const activityButton = page.getByRole('button', {
    name: 'Open session activity',
  });
  if ((await activityButton.getAttribute('aria-expanded')) !== 'true')
    await activityButton.click();
  const activity = page.locator('.activity-panel.is-open');
  await expect(activity).toBeVisible();
  await expect(activity.locator('.activity-panel-bar')).toHaveCSS(
    'min-height',
    '40px',
  );
  await expect(activity.locator('.activity-panel-bar')).toHaveCSS(
    'padding-right',
    '132px',
  );
});

test('mobile outline searches and jumps without covering the viewport', async ({
  page,
}) => {
  await openTurns(page, 50);
  await page
    .getByRole('button', { name: 'Open transcript outline', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Transcript outline',
    exact: true,
  });
  const search = dialog.getByRole('searchbox');
  await search.fill('User prompt 010');
  await expect(dialog.locator('.transcript-outline-jump')).toHaveCount(1);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('Missing mobile outline geometry');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  await dialog.locator('.transcript-outline-jump').click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator('.message-user').filter({ hasText: 'User prompt 010' }),
  ).toBeVisible();
});

test('current turn remains correct when its user row is virtualized away @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await openTurns(page, 2, 50);
  const markers = page.locator('.transcript-minimap-marker');
  await expect(markers).toHaveCount(2);
  await expect(markers.last()).toHaveAttribute('aria-current', 'location');
  await page.locator('.session-transcript-scroll').evaluate((element) => {
    element.scrollTop = 1200;
  });
  await expect(
    page.locator('.message-user').filter({ hasText: 'User prompt 001' }),
  ).toHaveCount(0);
  await expect(markers.first()).toHaveAttribute('aria-current', 'location');
});

test('short desktop rail fits above a growing composer without overlapping targets @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 460 });
  await openTurns(page, 100);
  await page
    .getByRole('textbox', { name: 'Message Pi' })
    .fill(
      Array.from({ length: 7 }, (_, index) => `Draft line ${index}`).join('\n'),
    );
  const rail = page.locator('.transcript-minimap');
  await expect(rail).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rail = document.querySelector('.transcript-minimap');
        const scroll = document.querySelector('.session-transcript-scroll');
        const composer = document.querySelector('.composer');
        if (!rail || !scroll || !composer) return false;
        const rect = rail.getBoundingClientRect();
        const markers = Array.from(
          rail.querySelectorAll('.transcript-minimap-marker'),
        ).map((marker) => marker.getBoundingClientRect());
        return (
          markers.length > 0 &&
          rect.top >= scroll.getBoundingClientRect().top &&
          rect.bottom <= composer.getBoundingClientRect().top &&
          markers.every(
            (marker, index) =>
              marker.top >= rect.top &&
              marker.bottom <= rect.bottom &&
              (index === 0 ||
                marker.top >= (markers[index - 1]?.bottom ?? 0) - 1),
          )
        );
      }),
    )
    .toBe(true);
  await rail
    .getByRole('button', { name: 'Open transcript outline', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Transcript outline', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    rail.getByRole('button', { name: 'Open transcript outline', exact: true }),
  ).toBeFocused();
});
