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
    await tasks.getByText('Tasks', { exact: true }).click();
    await expect(taskHeader).toHaveAttribute('aria-expanded', 'true');
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
    await expect(finished).toHaveCount(0);
    await expect(delegates.locator('.delegate-row')).toHaveCount(
      active ? 1 : 0,
    );
    if (active) {
      await expect(delegates.locator('.delegate-row-properties')).toContainText(
        'luna-high',
      );
    }
  });
}
