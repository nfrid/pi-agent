import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  buildWorkingScenario,
  installVisualStateScenario,
  VISUAL_TIMESTAMP,
} from './visual-state-fixtures';

const PIN_KEY = 'pi-dashboard-activity-panel-pinned-v1';

async function openWorkingSession(
  page: Page,
  width: number,
  height: number,
  rowCount = 100,
  liveState: 'working' | 'compacting' = 'working',
) {
  await page.setViewportSize({ width, height });
  const base = buildWorkingScenario();
  const sessionSnapshot = base.sessionSnapshot;
  if (!sessionSnapshot) throw new Error('working scenario has no session');
  const entries = Array.from({ length: rowCount }, (_, index) => ({
    type: 'message',
    id: `layout-message-${index}`,
    message: {
      role: index % 2 ? 'assistant' : 'user',
      timestamp: VISUAL_TIMESTAMP - (100 - index) * 1_000,
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
    snapshot: {
      ...base.snapshot,
      runtimes: base.snapshot.runtimes.map((runtime) => ({
        ...runtime,
        liveState,
      })),
    },
    sessionSnapshot: {
      ...sessionSnapshot,
      entries,
      active: sessionSnapshot.active
        ? { ...sessionSnapshot.active, liveState }
        : sessionSnapshot.active,
    },
  });
  await expect(page.locator('.session-transcript-scroll')).toBeVisible();
  await expect(
    page
      .locator(
        rowCount > 80
          ? '.transcript-virtual-row'
          : '.transcript [data-transcript-key]',
      )
      .last(),
  ).toBeVisible();
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
      scrollbarWidth: scroll.getBoundingClientRect().width - scroll.clientWidth,
    };
  });
  expect(layout.columns.split(' ').length).toBe(3);
  expect(layout.panel.width).toBe(276);
  expect(layout.panel.top).toBe(0);
  expect(layout.panel.right).toBe(1440);
  expect(layout.panel.left).toBe(layout.scroll.right);
  expect(layout.scroll.left).toBe(276);
  expect(layout.row.width).toBeLessThanOrEqual(820);
  expect(layout.row.left).toBeGreaterThanOrEqual(layout.scroll.left + 48 - 1);
  expect(
    Math.abs(layout.row.right - layout.composer.right),
  ).toBeLessThanOrEqual(Math.max(layout.scrollbarWidth, 14));
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
  const unpinnedGeometry = await page.evaluate(() => {
    const scroll = document.querySelector('.session-transcript-scroll');
    const row = document.querySelector('.transcript-virtual-row');
    const composer = document.querySelector('.composer');
    if (!scroll || !row || !composer)
      throw new Error('unpinned geometry missing');
    return {
      scroll: scroll.getBoundingClientRect(),
      row: row.getBoundingClientRect(),
      composer: composer.getBoundingClientRect(),
      scrollbarWidth: scroll.getBoundingClientRect().width - scroll.clientWidth,
    };
  });
  expect(unpinnedGeometry.row.left).toBeGreaterThanOrEqual(
    unpinnedGeometry.scroll.left + 48 - 1,
  );
  expect(
    Math.abs(unpinnedGeometry.row.right - unpinnedGeometry.composer.right),
  ).toBeLessThanOrEqual(Math.max(unpinnedGeometry.scrollbarWidth, 14));
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
  await expect(
    page.getByRole('dialog', { name: 'Delegate · Review worker' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.activity-panel.is-open')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.activity-panel.is-open')).toHaveCount(0);

  expect(await page.evaluate((key) => localStorage.getItem(key), PIN_KEY)).toBe(
    'false',
  );
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Open session activity' }),
  ).toBeVisible();
  await expect(page.locator('.activity-panel.is-open')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open session activity' }).click();
  await expect(page.locator('.activity-panel')).toHaveClass(/is-open/);
  await page
    .getByRole('button', { name: 'Pin activity panel', exact: true })
    .click();
  await expect(page.locator('.activity-panel')).toHaveClass(/is-pinned/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open session activity' }).click();
  await expect(page.locator('.activity-panel')).toHaveClass(/is-overlay/);
  await expect(
    page.getByRole('button', { name: 'Close activity panel' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close activity panel' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.activity-panel')).toHaveClass(/is-pinned/);
});

test('live events use the persisted content edges without changing virtual rows @desktop', async ({
  page,
}) => {
  await openWorkingSession(page, 1440, 900, 100, 'compacting');
  await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible();
  const geometry = await page.evaluate(() => {
    const live = document.querySelector('.live-compaction-event');
    const row = document.querySelector('.transcript-virtual-row');
    if (!live || !row)
      throw new Error('live and persisted transcript rows missing');
    const liveRect = live.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const composer = document.querySelector('.composer');
    const scroll = document.querySelector('.session-transcript-scroll');
    if (!composer || !scroll) throw new Error('composer or scroll missing');
    const composerRect = composer.getBoundingClientRect();
    return {
      live: {
        left: liveRect.left,
        right: liveRect.right,
        width: liveRect.width,
      },
      row: { left: rowRect.left, right: rowRect.right, width: rowRect.width },
      composer: { right: composerRect.right },
      scrollbarWidth: scroll.getBoundingClientRect().width - scroll.clientWidth,
    };
  });
  expect(geometry.live.left).toBe(geometry.row.left);
  expect(geometry.live.right).toBe(geometry.row.right);
  expect(geometry.live.width).toBe(geometry.row.width);
  expect(
    Math.abs(geometry.live.right - geometry.composer.right),
  ).toBeLessThanOrEqual(Math.max(geometry.scrollbarWidth, 14));
  expect(geometry.live.left).toBeGreaterThanOrEqual(48);
  await expect(page.locator('.session-transcript-scroll')).toHaveScreenshot(
    'live-compaction-aligned.png',
    { animations: 'disabled' },
  );
});

for (const rowCount of [20, 100]) {
  test(`transcript gutters scroll natively and keep the tail clear (${rowCount} rows) @desktop`, async ({
    page,
  }) => {
    await openWorkingSession(page, 1600, 900, rowCount);
    const scroll = page.locator('.session-transcript-scroll');
    const rows = page.locator(
      rowCount > 80
        ? '.transcript-virtual-row'
        : '.transcript [data-transcript-key]',
    );
    const composer = page.locator('form.composer');
    const geometry = await scroll.boundingBox();
    const composerRect = await composer.boundingBox();
    if (!geometry || !composerRect) throw new Error('scroll/composer missing');
    await expect
      .poll(async () => {
        const last = await rows.last().boundingBox();
        return last ? composerRect.y - (last.y + last.height) : -1;
      })
      .toBeGreaterThanOrEqual(0);
    const rowGeometry = await rows.last().evaluate((element) => {
      const row = element.getBoundingClientRect();
      const scroll = element.closest('.session-transcript-scroll');
      const composer = document.querySelector('.composer');
      if (!scroll || !composer) throw new Error('row geometry missing');
      return {
        row,
        scroll: scroll.getBoundingClientRect(),
        composer: composer.getBoundingClientRect(),
        scrollbarWidth:
          scroll.getBoundingClientRect().width - scroll.clientWidth,
      };
    });
    expect(rowGeometry.row.width).toBeLessThanOrEqual(820);
    expect(rowGeometry.row.left).toBeGreaterThanOrEqual(
      rowGeometry.scroll.left + 48 - 1,
    );
    expect(
      Math.abs(rowGeometry.row.right - rowGeometry.composer.right),
    ).toBeLessThanOrEqual(Math.max(rowGeometry.scrollbarWidth, 14));
    for (const x of [geometry.x + 8, geometry.x + geometry.width - 12]) {
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const before = await scroll.evaluate((element) => element.scrollTop);
      // Beside the composer, not just in the transcript's upper gutters.
      await page.mouse.move(x, composerRect.y + 20);
      await page.mouse.wheel(0, -240);
      await expect
        .poll(() => scroll.evaluate((element) => element.scrollTop))
        .toBeLessThan(before - 50);
    }
    // Sidebar scrolling must not bubble through to the transcript.
    const beforePanel = await scroll.evaluate((element) => element.scrollTop);
    await page.mouse.move(1450, 200);
    await page.mouse.wheel(0, 240);
    await expect(scroll).toHaveJSProperty('scrollTop', beforePanel);
  });
}

test('mobile uses header activity button, close action, and right-edge gesture without a mid-edge handle', async ({
  page,
}) => {
  await openWorkingSession(page, 390, 844);
  const mobileGeometry = await page
    .locator('.transcript-virtual-row')
    .first()
    .evaluate((element) => {
      const row = element.getBoundingClientRect();
      const scroll = element.closest('.session-transcript-scroll');
      if (!scroll) throw new Error('mobile scroll missing');
      const scrollRect = scroll.getBoundingClientRect();
      return {
        leftGap: row.left - scrollRect.left,
        rightGap: scrollRect.right - row.right,
      };
    });
  expect(mobileGeometry.leftGap).toBeCloseTo(13, 0);
  expect(mobileGeometry.rightGap).toBeGreaterThanOrEqual(12);
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
  await page
    .locator('.activity-panel')
    .getByRole('button', { name: /Review worker/ })
    .click();
  const inspector = page.getByRole('dialog', {
    name: 'Delegate · Review worker',
  });
  await expect(inspector).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect(page.locator('.activity-panel')).toBeVisible();
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
      new TouchEvent('touchstart', {
        touches: [start],
        changedTouches: [start],
      }),
    );
    window.dispatchEvent(new TouchEvent('touchend', { changedTouches: [end] }));
  });
  await expect(page.locator('.activity-panel')).toHaveClass(/is-open/);
  await page.mouse.click(12, 400);
  await expect(page.locator('.activity-panel.is-open')).toHaveCount(0);
});
