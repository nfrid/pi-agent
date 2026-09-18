import { expect, test } from '@playwright/test';
import {
  buildActivityPanelScenario,
  installVisualStateScenario,
} from './visual-state-fixtures';

for (const active of [false, true]) {
  test(`section titles toggle ${active ? 'active' : 'completed'} activity and retain delegate metadata @desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installVisualStateScenario(page, buildActivityPanelScenario(active));
    const panel = page.locator('.activity-panel');
    const tasks = panel.getByRole('region', { name: 'Tasks', exact: true });
    const delegates = panel.getByRole('region', {
      name: 'Delegates',
      exact: true,
    });
    const taskHeader = tasks.getByRole('heading').getByRole('button');
    const delegateHeader = delegates.getByRole('heading').getByRole('button');
    await expect(taskHeader).toHaveAttribute('aria-expanded', 'false');
    await expect(taskHeader.getByText('3 more', { exact: true })).toBeVisible();
    await expect(
      delegateHeader.getByText('3 more', { exact: true }),
    ).toBeVisible();
    await expect(delegates.locator('.delegate-row')).toHaveCount(3);
    await expect(
      delegates.getByText('Finished worker 6', { exact: true }),
    ).toBeVisible();
    await expect(
      delegates.getByText('Finished worker 5', { exact: true }),
    ).toBeVisible();
    await tasks.getByText('Tasks', { exact: true }).click();
    await expect(taskHeader).toHaveAttribute('aria-expanded', 'true');
    await expect(taskHeader.getByText('3 more', { exact: true })).toHaveCount(
      0,
    );
    await expect(
      tasks.getByText('Deploy client bundle', { exact: false }),
    ).toBeVisible();
    await taskHeader.press('Enter');
    await expect(taskHeader).toHaveAttribute('aria-expanded', 'false');
    await expect(
      tasks.getByText('Deploy client bundle', { exact: false }),
    ).toHaveCount(0);
    await delegates.getByText('Delegates', { exact: true }).click();
    await expect(delegateHeader).toHaveAttribute('aria-expanded', 'true');
    await expect(
      delegateHeader.getByText('3 more', { exact: true }),
    ).toHaveCount(0);
    await expect(delegates.locator('.delegate-row')).toHaveCount(6);
    const finished = delegates
      .locator('.delegate-row')
      .filter({ hasText: 'Finished worker 6' });
    await expect(finished).toBeVisible();
    await expect(finished.locator('.delegate-row-properties')).toContainText(
      'luna-medium',
    );
    await expect(finished.locator('.delegate-row-properties')).toContainText(
      /read\/(?:write)|read-only/,
    );
    await expect(finished.locator('.delegate-row-properties')).toContainText(
      /\d+[smh]/,
    );
    await delegateHeader.press('Space');
    await expect(delegateHeader).toHaveAttribute('aria-expanded', 'false');
    await expect(finished).toBeVisible();
    await expect(
      delegateHeader.getByText('3 more', { exact: true }),
    ).toBeVisible();
    await expect(
      delegates.getByText('Finished worker 2', { exact: true }),
    ).toHaveCount(0);
    await expect(delegates.locator('.delegate-row')).toHaveCount(3);
    if (active) {
      await expect(
        delegates
          .locator('.delegate-row')
          .filter({ hasText: 'Activity panel visual refinement' })
          .locator('.delegate-row-properties'),
      ).toContainText('luna-high');
    }
  });
}

test('task descriptions flow around corner metadata at narrow and wide widths @desktop', async ({
  page,
}, testInfo) => {
  for (const width of [420, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    await installVisualStateScenario(
      page,
      buildActivityPanelScenario(true, { layoutStress: true }),
    );
    let tasks = page.getByRole('region', { name: 'Tasks', exact: true });
    if ((await tasks.count()) === 0) {
      await page.getByRole('button', { name: 'Open session activity' }).click();
      tasks = page.getByRole('region', { name: 'Tasks', exact: true });
    }
    await tasks.getByRole('heading').getByRole('button').click();
    const row = tasks.locator('.task-row').first();
    const rowBox = await row.boundingBox();
    const stateBox = await row.locator('.surface-state').boundingBox();
    const metaBox = await row.locator('.task-row-meta').boundingBox();
    const dependency = row.locator('.task-row-meta small');
    const idLines = await row.locator('strong').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].map(({ top, bottom }) => ({
        top,
        bottom,
      }));
    });
    expect(idLines).toHaveLength(1);
    const priorityBox = await row.locator('.task-row-meta b').boundingBox();
    if (!priorityBox) throw new Error('Task priority is missing.');
    const idCenter = (idLines[0].top + idLines[0].bottom) / 2;
    expect(
      Math.abs(idCenter - (priorityBox.y + priorityBox.height / 2)),
    ).toBeLessThanOrEqual(2);
    if (!rowBox || !stateBox || !metaBox)
      throw new Error('Task corner geometry is missing.');
    expect(Math.abs(stateBox.x - (rowBox.x + 11))).toBeLessThanOrEqual(2);
    expect(stateBox.y).toBeGreaterThanOrEqual(rowBox.y);
    expect(stateBox.y).toBeLessThan(rowBox.y + rowBox.height / 2);
    expect(Math.abs(metaBox.y - stateBox.y)).toBeLessThanOrEqual(2);
    expect(
      Math.abs(idCenter - (stateBox.y + stateBox.height / 2)),
    ).toBeLessThanOrEqual(2);
    await testInfo.attach(`expanded-tasks-${width}`, {
      body: await tasks.screenshot({
        path: testInfo.outputPath(`expanded-tasks-${width}.png`),
      }),
      contentType: 'image/png',
    });
    expect(
      Math.abs(metaBox.x + metaBox.width - (rowBox.x + rowBox.width - 11)),
    ).toBeLessThanOrEqual(2);
    expect(
      await dependency.evaluate((element) => element.clientHeight),
    ).toBeGreaterThan(12);

    const lines = await row.locator('.task-row-main').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].map(
        ({ top, bottom, left, right }) => ({
          top,
          bottom,
          left,
          right,
        }),
      );
    });
    const lineRects = [
      ...new Map(lines.map((line) => [line.top, line])).values(),
    ];
    expect(lineRects.length).toBeGreaterThan(2);
    const firstLine = lineRects[0];
    if (!firstLine) throw new Error('Task text line geometry is missing.');
    expect(firstLine.top).toBeGreaterThanOrEqual(metaBox.y);
    expect(firstLine.left).toBeGreaterThan(rowBox.x + 11);
    expect(firstLine.right).toBeLessThanOrEqual(metaBox.x + 1);
    const lowerLines = lineRects.filter(
      (line) => line.top >= metaBox.y + metaBox.height - 1,
    );
    expect(lowerLines.length).toBeGreaterThan(0);
    expect(Math.min(...lowerLines.map((line) => line.left))).toBeLessThan(
      firstLine.left,
    );
    expect(
      Math.max(...lowerLines.map((line) => line.right - line.left)),
    ).toBeGreaterThan(firstLine.right - firstLine.left);
    expect(
      await row.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
});

test('activity section hit targets span the panel while content stays inset @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installVisualStateScenario(page, buildActivityPanelScenario(true));
  const panel = page.locator('.activity-panel');
  const panelBox = await panel.boundingBox();
  if (!panelBox) throw new Error('Activity panel is not laid out.');
  const inset = await panel.evaluate((element) =>
    Number.parseFloat(
      getComputedStyle(element).getPropertyValue('--activity-panel-inset'),
    ),
  );
  expect(inset).toBe(12);

  const tasks = panel.getByRole('region', { name: 'Tasks', exact: true });
  const taskHeader = tasks.getByRole('heading').getByRole('button');
  const taskHeaderBox = await taskHeader.boundingBox();
  const taskTitleBox = await tasks
    .locator('.activity-panel-heading-title')
    .boundingBox();
  const taskTextBox = await tasks
    .locator('.task-row-main')
    .first()
    .boundingBox();
  if (!taskHeaderBox || !taskTitleBox || !taskTextBox)
    throw new Error('Task geometry is missing.');
  expect(taskHeaderBox.x).toBe(panelBox.x);
  expect(taskHeaderBox.width).toBe(panelBox.width);
  expect(taskTitleBox.x).toBe(taskHeaderBox.x + inset);
  expect(taskTextBox.x).toBeGreaterThanOrEqual(panelBox.x + inset);

  await taskHeader.click({ position: { x: 1, y: 1 } });
  await expect(taskHeader).toHaveAttribute('aria-expanded', 'true');

  const delegates = panel.getByRole('region', {
    name: 'Delegates',
    exact: true,
  });
  const delegateToggle = delegates.locator('.delegate-row-toggle').first();
  const delegateBox = await delegateToggle.boundingBox();
  if (!delegateBox) throw new Error('Delegate row geometry is missing.');
  const delegateGlyphBox = await delegateToggle
    .locator('.surface-state')
    .boundingBox();
  if (!delegateGlyphBox) throw new Error('Delegate glyph geometry is missing.');
  expect(delegateBox.x).toBe(panelBox.x);
  expect(delegateBox.width).toBe(panelBox.width);
  expect(delegateGlyphBox.x).toBe(delegateBox.x + inset);
  await delegateToggle.hover({ position: { x: 1, y: delegateBox.height / 2 } });
  await expect
    .poll(() =>
      delegateToggle.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    )
    .not.toBe('rgba(0, 0, 0, 0)');
  await expect(panel).toHaveScreenshot('activity-row-edge-hover.png', {
    animations: 'disabled',
  });
  await delegateToggle.click({ position: { x: 1, y: delegateBox.height / 2 } });
  await expect(page.locator('.delegate-transcript-drawer')).toBeVisible();
});
