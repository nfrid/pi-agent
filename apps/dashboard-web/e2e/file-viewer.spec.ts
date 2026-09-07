import { expect, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
} from './dashboard-fixtures';

const sessionId = 'file-viewer-session';
const snapshot = {
  serverId: 'file-viewer-test',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  unread: [],
  sessions: [
    { id: sessionId, file: '/tmp/viewer.jsonl', cwd: '/project', updatedAt: 1 },
  ],
};
const source = Array.from(
  { length: 240 },
  (_, i) => `export const value${i + 1} = ${i + 1};`,
).join('\n');
const markdown =
  '# Guide\n\n[Implementation](../src/file.ts:123-125)\n\n[Section](#details)\n\n[Other document](other.md)\n\n' +
  Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.\n\n`).join('') +
  '## Details\n\nTarget heading content.\n\n![Do not load](https://example.com/tracker.png)';

for (const suffix of ['', ' @desktop']) {
  test(`file viewer opens links and preserves navigation${suffix}`, async ({
    page,
  }, testInfo) => {
    const requests: Record<string, unknown>[] = [];
    const remoteImages: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('tracker.png'))
        remoteImages.push(request.url());
    });
    await installDashboardBootstrap(page, snapshot, {
      sessionSnapshot: {
        entries: [
          {
            type: 'message',
            id: 'file-links',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: '[Method](src/file.ts:123-125) [Guide](docs/guide.md) [Absolute](/Users/nfrid/somefile.md) [Home](~/somefile.md) [Web](https://example.com)',
                },
              ],
            },
          },
        ],
        entriesComplete: true,
        active: { messages: [], tools: [], delegates: [], truncated: false },
        completeThroughCursor: true,
      },
    });
    await page.route('**/trpc/readFile*', async (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-dashboard-token']).toBe('test-token');
      const input = dashboardTrpcInput(request);
      requests.push(input);
      const requested = String(input.path);
      const path = requested.startsWith('/')
        ? requested
        : requested.startsWith('~/')
          ? `/Users/nfrid/${requested.slice(2)}`
          : requested === '../src/file.ts'
            ? '/project/src/file.ts'
            : `${input.cwd}/${requested}`;
      await route.fulfill({
        contentType: 'application/json',
        body: trpcData({
          path,
          content: path.endsWith('.ts')
            ? source
            : path.endsWith('guide.md')
              ? markdown
              : '# Other document\n\nSome content.',
        }),
      });
    });
    await page.goto(`/sessions/${sessionId}`);
    const transcript = page.getByRole('region', {
      name: 'Transcript',
      exact: true,
    });
    await expect(
      transcript.getByRole('link', { name: 'Method', exact: true }),
    ).toBeVisible();
    expect(requests).toHaveLength(0);
    await expect(
      transcript.getByRole('link', { name: 'Web', exact: true }),
    ).toHaveAttribute('target', '_blank');
    await transcript.getByRole('link', { name: 'Method', exact: true }).click();
    const viewer = page.getByRole('dialog').last();
    await expect(viewer).toBeVisible();
    await expect(
      viewer.getByText('export const value123 = 123;', { exact: false }),
    ).toBeVisible();
    expect(requests[0]).toEqual({ path: 'src/file.ts', cwd: '/project' });
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
    // The real renderer must highlight the requested range, not just scroll nearby.
    await expect(viewer.locator('[data-selected-line]').first()).toBeVisible();
    await expect(
      viewer.locator('[data-line][data-selected-line]'),
    ).toContainText([
      'export const value123 = 123;',
      'export const value124 = 124;',
      'export const value125 = 125;',
    ]);
    await expect
      .poll(async () =>
        viewer
          .locator('[data-line][data-selected-line] span')
          .evaluateAll(
            (tokens) =>
              new Set(tokens.map((token) => getComputedStyle(token).color))
                .size,
          ),
      )
      .toBeGreaterThan(1);
    await page.screenshot({ path: testInfo.outputPath('source.png') });
    await viewer
      .getByRole('button', { name: 'Close file viewer', exact: true })
      .click();
    await expect(
      transcript.getByRole('link', { name: 'Method', exact: true }),
    ).toBeFocused();

    await transcript.getByRole('link', { name: 'Guide', exact: true }).click();
    await expect(
      viewer.getByRole('heading', { name: 'Guide', exact: true }),
    ).toBeVisible();
    await viewer
      .getByRole('link', { name: 'Implementation', exact: true })
      .click();
    await expect(
      viewer.getByText('export const value123 = 123;', { exact: false }),
    ).toBeVisible();
    expect(requests.at(-1)).toEqual({
      path: '../src/file.ts',
      cwd: '/project/docs',
    });
    await viewer
      .getByRole('region', { name: 'File source', exact: true })
      .hover();
    await page.mouse.wheel(0, -10000);
    await expect(
      viewer.getByText('export const value1 = 1;', { exact: false }),
    ).toBeInViewport();
    await viewer
      .getByRole('button', { name: 'Refresh file', exact: true })
      .click();
    await expect(
      viewer.getByText('export const value1 = 1;', { exact: false }),
    ).toBeInViewport();
    await viewer.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(
      viewer.getByRole('heading', { name: 'Guide', exact: true }),
    ).toBeVisible();
    await viewer.getByRole('button', { name: 'Forward', exact: true }).click();
    await expect(
      viewer.getByText('export const value1 = 1;', { exact: false }),
    ).toBeInViewport();
    await viewer.getByRole('button', { name: 'Back', exact: true }).click();
    await viewer.getByRole('link', { name: 'Section', exact: true }).click();
    await expect(
      viewer.getByRole('heading', { name: 'Details', exact: true }),
    ).toBeInViewport();
    await expect(
      viewer.getByRole('button', { name: 'Forward', exact: true }),
    ).toBeDisabled();
    await viewer.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(
      viewer.getByRole('link', { name: 'Section', exact: true }),
    ).toBeInViewport();
    await viewer.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(viewer.getByText('# Guide', { exact: false })).toBeVisible();
    await viewer.getByRole('button', { name: 'Preview', exact: true }).click();
    await viewer
      .getByRole('button', { name: 'Refresh file', exact: true })
      .click();
    await expect(
      viewer.getByRole('heading', { name: 'Guide', exact: true }),
    ).toBeVisible();
    expect(remoteImages).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(viewer).not.toBeVisible();

    for (const [label, path] of [
      ['Absolute', '/Users/nfrid/somefile.md'],
      ['Home', '~/somefile.md'],
    ]) {
      await transcript.getByRole('link', { name: label, exact: true }).click();
      await expect(
        viewer.getByRole('heading', { name: 'Other document', exact: true }),
      ).toBeVisible();
      expect(requests.at(-1)?.path).toBe(path);
      await viewer
        .getByRole('button', { name: 'Close file viewer', exact: true })
        .click();
    }
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
    expect(page.context().pages()).toHaveLength(1);
  });
}
