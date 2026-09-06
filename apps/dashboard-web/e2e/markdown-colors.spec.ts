import { expect, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const snapshot = {
  serverId: 'markdown-colors-test',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [
    {
      id: 'markdown-colors-session',
      file: '/tmp/markdown-colors-session.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    },
  ],
  unread: [],
};

for (const title of [
  'transcript Markdown uses theme colors',
  'transcript Markdown uses theme colors @desktop',
]) {
  test(title, async ({ page }) => {
    await installDashboardBootstrap(page, snapshot, {
      sessionSnapshot: {
        entries: [
          {
            type: 'message',
            id: 'markdown-colors-message',
            message: {
              role: 'assistant',
              content: `# Heading one
## Heading two
### Heading three
#### Heading four
##### Heading five
###### Heading six

*emphasis* **strong** \`inline code\` [link](https://example.com)

\`\`\`text
fenced code
\`\`\``,
            },
          },
        ],
        entriesComplete: true,
        active: { messages: [], tools: [], delegates: [], truncated: false },
        completeThroughCursor: true,
      },
    });

    await page.goto('/sessions/markdown-colors-session');
    const markdown = page.locator('.markdown');
    const expectedHeadingColors = [
      'rgb(189, 147, 249)',
      'rgb(255, 184, 108)',
      'rgb(255, 121, 198)',
      'rgb(80, 250, 123)',
      'rgb(139, 233, 253)',
      'rgb(98, 114, 164)',
    ];

    for (const [index, color] of expectedHeadingColors.entries()) {
      await expect(markdown.locator(`h${index + 1}`)).toHaveCSS('color', color);
    }
    await expect(markdown.locator('em')).toHaveCSS(
      'color',
      'rgb(241, 250, 140)',
    );
    await expect(markdown.locator('strong')).toHaveCSS(
      'color',
      'rgb(255, 184, 108)',
    );
    await expect(markdown.locator('p code')).toHaveCSS(
      'color',
      'rgb(80, 250, 123)',
    );
    await expect(markdown.locator('pre code')).toHaveCSS(
      'color',
      'rgb(248, 248, 242)',
    );
    await expect(markdown.locator('a')).toHaveCSS(
      'color',
      'rgb(139, 233, 253)',
    );
  });
}
