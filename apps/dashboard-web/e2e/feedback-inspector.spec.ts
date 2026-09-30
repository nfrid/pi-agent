import { expect, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const snapshot = {
  serverId: 'feedback-inspector-e2e',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [
    {
      id: 'feedback-session',
      file: '/tmp/feedback-session.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    },
  ],
  unread: [],
};

for (const suffix of ['', ' @desktop']) {
  test(`shows sent feedback as Markdown in the tool inspector${suffix}`, async ({
    page,
  }) => {
    const message = `Please review this.\n\n- Keep the API stable\n\n\`\`\`ts\nconst reviewed = true;\n\`\`\``;
    await installDashboardBootstrap(page, snapshot, {
      sessionSnapshot: {
        entries: [
          { type: 'session', id: 'feedback-session', cwd: '/tmp' },
          {
            type: 'message',
            id: 'feedback-call-message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'toolCall',
                  id: 'feedback-call',
                  name: 'delegate_jobs',
                  arguments: {
                    action: 'feedback',
                    id: 'job-1',
                    message,
                  },
                },
              ],
            },
          },
          {
            type: 'message',
            id: 'feedback-result-message',
            message: {
              role: 'toolResult',
              toolCallId: 'feedback-call',
              content: [{ type: 'text', text: 'Feedback sent.' }],
              isError: false,
            },
          },
        ],
        entriesComplete: true,
        active: { messages: [], tools: [], delegates: [], truncated: false },
        completeThroughCursor: true,
      },
    });
    await page.route('**/api/usage', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/sessions/feedback-session');
    const activityButton = page.getByRole('button', {
      name: 'Open session activity',
    });
    if (await activityButton.isVisible()) await activityButton.click();
    const activity = page.locator('.activity-panel');
    const streamButton = activity.getByRole('button', {
      name: /Show all activity/,
    });
    if (await streamButton.isVisible()) await streamButton.click();
    const row = page
      .locator('.tool-detail')
      .filter({ hasText: 'Sending feedback to delegate job' });
    await expect(row).toBeVisible();
    await row.locator(':scope > summary.tool-step').click();
    const inspector = row.locator('.tool-inspector');
    await expect(inspector.getByText('Feedback message')).toBeVisible();
    await expect(inspector.locator('.markdown p')).toHaveText(
      'Please review this.',
    );
    await expect(inspector.locator('.markdown li')).toHaveText(
      'Keep the API stable',
    );
    await expect(inspector.locator('.markdown code.language-ts')).toContainText(
      'const reviewed = true;',
    );
    await expect(inspector).toContainText('Feedback sent.');
    await expect(inspector.locator('.tool-markdown-result')).toContainText(
      'const reviewed = true;',
    );
  });
}
