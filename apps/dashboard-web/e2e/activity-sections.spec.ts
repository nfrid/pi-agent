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
  expect(taskTextBox.x).toBeGreaterThan(panelBox.x + inset);

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
  await delegateToggle.click({ position: { x: 1, y: delegateBox.height / 2 } });
  await expect(page.locator('.delegate-transcript-drawer')).toBeVisible();
});
