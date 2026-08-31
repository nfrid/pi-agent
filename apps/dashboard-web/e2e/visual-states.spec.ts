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
  await expect(page.locator('.transcript-thinking')).toHaveCount(0);
  await expect(page.locator('.transcript-tool-stream')).toHaveCount(1);
  const activityDisclosure = page.getByRole('button', {
    name: /Show all activity.*8 hidden steps/,
  });
  const omission = page.getByRole('button', {
    name: 'Show 8 hidden steps',
  });
  await expect(activityDisclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(omission).toBeVisible();
  await expect(page.locator('.tool-stream-items .tool-detail')).toHaveCount(1);
  await expect(
    page.locator('.tool-stream-items .transcript-thinking-blob'),
  ).toHaveCount(2);
  const metadata = page.locator('.tool-stream-metadata');
  await expect(metadata).toContainText('Edited');
  await expect(metadata).not.toContainText('complete');
  await expect(metadata).toContainText('5 thoughts');
  await expect(metadata).toContainText('5 calls');
  await expect(page.getByText(/Tasks · T1 added/)).toHaveCount(0);
  const streamGeometry = await page
    .locator('.transcript-tool-stream')
    .evaluate((stream) => {
      const meta = stream.querySelector<HTMLElement>('.tool-stream-meta');
      const items = stream.querySelector<HTMLElement>('.tool-stream-items');
      const icon = stream.querySelector<HTMLElement>(
        '.transcript-disclosure-icon',
      );
      const iconSvg = icon?.querySelector<SVGElement>('svg');
      const firstDot = stream.querySelector<HTMLElement>('.tool-step-dot');
      const phase = stream.querySelector<HTMLElement>('.tool-stream-phase');
      const metadataNode = stream.querySelector<HTMLElement>(
        '.tool-stream-metadata',
      );
      const thoughts = stream.querySelector<HTMLElement>(
        '.tool-stream-metadata-thoughts',
      );
      const calls = stream.querySelector<HTMLElement>(
        '.tool-stream-metadata-calls',
      );
      const messageTime = stream.querySelector<HTMLElement>(
        '.message-assistant .transcript-time',
      );
      const thoughtTime = stream.querySelector<HTMLElement>('.thinking-time');
      const toolTime = stream.querySelector<HTMLElement>('.tool-step-time');
      if (
        !meta ||
        !items ||
        !icon ||
        !iconSvg ||
        !firstDot ||
        !phase ||
        !metadataNode ||
        !thoughts ||
        !calls ||
        !messageTime ||
        !thoughtTime ||
        !toolTime
      )
        throw new Error('tool stream presentation missing');
      const iconRect = icon.getBoundingClientRect();
      const iconSvgRect = iconSvg.getBoundingClientRect();
      return {
        metaPaddingLeft: getComputedStyle(meta).paddingLeft,
        metaPaddingRight: getComputedStyle(meta).paddingRight,
        itemsPaddingLeft: getComputedStyle(items).paddingLeft,
        itemsPaddingRight: getComputedStyle(items).paddingRight,
        iconCenter: iconRect.x + iconRect.width / 2,
        iconSvgCenter: iconSvgRect.x + iconSvgRect.width / 2,
        iconSvgWidth: iconSvgRect.width,
        iconSvgHeight: iconSvgRect.height,
        dotCenter:
          firstDot.getBoundingClientRect().x + firstDot.offsetWidth / 2,
        phaseColor: getComputedStyle(phase).color,
        metadataColor: getComputedStyle(metadataNode).color,
        thoughtsColor: getComputedStyle(thoughts).color,
        callsColor: getComputedStyle(calls).color,
        messageTimeRight: messageTime.getBoundingClientRect().right,
        thoughtTimeRight: thoughtTime.getBoundingClientRect().right,
        toolTimeRight: toolTime.getBoundingClientRect().right,
      };
    });
  expect(streamGeometry).toMatchObject({
    metaPaddingLeft: '0px',
    metaPaddingRight: '0px',
    itemsPaddingLeft: '0px',
    itemsPaddingRight: '0px',
  });
  expect(streamGeometry.iconSvgWidth).toBe(12);
  expect(streamGeometry.iconSvgHeight).toBe(12);
  expect(
    Math.abs(streamGeometry.iconCenter - streamGeometry.iconSvgCenter),
  ).toBeLessThan(0.5);
  expect(
    Math.abs(streamGeometry.iconCenter - streamGeometry.dotCenter),
  ).toBeLessThan(1);
  expect(streamGeometry.phaseColor).not.toBe(streamGeometry.metadataColor);
  expect(streamGeometry.thoughtsColor).not.toBe(streamGeometry.metadataColor);
  expect(streamGeometry.callsColor).not.toBe(streamGeometry.metadataColor);
  expect(streamGeometry.thoughtsColor).not.toBe(streamGeometry.callsColor);
  expect(
    Math.abs(streamGeometry.messageTimeRight - streamGeometry.toolTimeRight),
  ).toBeLessThan(1);
  expect(
    Math.abs(streamGeometry.thoughtTimeRight - streamGeometry.toolTimeRight),
  ).toBeLessThan(1);
  const userPresentation = await page
    .locator('.message-user')
    .evaluate((user) => {
      const time = user.querySelector<HTMLElement>('.transcript-time');
      if (!time) throw new Error('user timestamp missing');
      return {
        backgroundImage: getComputedStyle(user).backgroundImage,
        timeRight: time.getBoundingClientRect().right,
      };
    });
  expect(userPresentation.backgroundImage).toContain('linear-gradient');
  expect(
    Math.abs(userPresentation.timeRight - streamGeometry.toolTimeRight),
  ).toBeLessThan(1);
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

  await omission.click();
  await expect(
    page.getByRole('button', { name: /Collapse activity.*8 hidden steps/ }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.tool-stream-items .tool-detail')).toHaveCount(5);
  await expect(
    page.locator('.tool-stream-items .transcript-thinking-blob'),
  ).toHaveCount(5);
  await expect(page.getByText(/Tasks · T1 added/)).toBeVisible();
  const expandedLayout = await page
    .locator('.transcript-tool-stream-expanded')
    .evaluate((stream) => {
      const metadata = stream.querySelector('.tool-stream-meta');
      const items = stream.querySelector('.tool-stream-items');
      if (!metadata || !items) throw new Error('tool disclosure missing');
      const backgroundProbe = document.createElement('div');
      backgroundProbe.style.background = 'var(--bg)';
      document.body.append(backgroundProbe);
      const pageBackground = getComputedStyle(backgroundProbe).backgroundColor;
      backgroundProbe.remove();
      return {
        metadataPosition: getComputedStyle(metadata).position,
        metadataBackground: getComputedStyle(metadata).backgroundColor,
        pageBackground,
        itemsOverflowY: getComputedStyle(items).overflowY,
        itemsMaxHeight: getComputedStyle(items).maxHeight,
      };
    });
  expect(expandedLayout).toMatchObject({
    metadataPosition: 'sticky',
    itemsOverflowY: 'visible',
    itemsMaxHeight: 'none',
  });
  expect(expandedLayout.metadataBackground).toBe(expandedLayout.pageBackground);
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
  await expect(
    failedTool.locator(':scope > summary .tool-argument-text'),
  ).toHaveText('bun test');
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
