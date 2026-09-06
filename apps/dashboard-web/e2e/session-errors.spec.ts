import { expect, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

test.describe('assistant error visibility', () => {
  const snapshot = {
    serverId: 'assistant-errors',
    revision: 1,
    cursor: 1,
    runtimes: [],
    workspaces: [],
    sessions: [
      {
        id: 'session-1',
        file: '/tmp/session-1.jsonl',
        cwd: '/tmp',
        updatedAt: 1,
      },
    ],
    unread: [],
  };

  test('shows live failed assistant text and error detail without expanding activity', async ({
    page,
  }) => {
    await installDashboardBootstrap(page, snapshot, {
      sessionSnapshot: {
        active: {
          messages: [
            {
              messageId: 'live-failure',
              role: 'assistant',
              content: [{ type: 'text', text: 'Partial answer' }],
              stopReason: 'error',
              errorMessage: 'Connection failed',
              phase: 'finished',
            },
          ],
          tools: [],
          delegates: [],
          truncated: false,
        },
      },
    });
    await page.goto('/sessions/session-1');
    await expect(page.getByText('Partial answer')).toBeVisible();
    await expect(page.locator('.transcript-message-error')).toContainText(
      'Connection failed',
    );
    await expect(page.locator('details.tool-detail')).toHaveCount(0);
  });

  test('shows persisted failed assistant text after reload', async ({
    page,
  }) => {
    await installDashboardBootstrap(page, snapshot, {
      sessionSnapshot: {
        entries: [
          {
            type: 'message',
            id: 'persisted-failure',
            message: {
              role: 'assistant',
              content: [],
              stopReason: 'error',
              errorMessage: 'Persisted provider failure',
            },
          },
        ],
      },
    });
    await page.goto('/sessions/session-1');
    await expect(page.locator('.transcript-message-error')).toContainText(
      'Persisted provider failure',
    );
    await page.reload();
    await expect(page.locator('.transcript-message-error')).toContainText(
      'Persisted provider failure',
    );
    await expect(page.locator('.transcript-message-error')).toHaveCount(1);
  });
});
