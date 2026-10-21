import { expect, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
} from './dashboard-fixtures';

const sessionId = 'file-viewer-media';
const snapshot = {
  serverId: 'file-viewer-media-test',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  unread: [],
  sessions: [
    { id: sessionId, file: '/tmp/viewer.jsonl', cwd: '/project', updatedAt: 1 },
  ],
};
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=';
const svg = (width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><script>fetch('https://example.invalid/script-executed')</script><image href="https://example.invalid/track.png" width="1" height="1"/><rect width="100%" height="100%" fill="#6d28d9"/><text x="32" y="80" fill="white" font-size="48">${width} x ${height}</text></svg>`;

for (const suffix of ['', ' @desktop']) {
  test(`image preview reports decode errors and recovers after refresh${suffix}`, async ({
    page,
  }) => {
    await installDashboardBootstrap(page, snapshot, {
      sessionSnapshot: {
        entries: [
          {
            type: 'message',
            id: 'image-link',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: '[Open image](images/pixel.png)' },
              ],
            },
          },
        ],
        entriesComplete: true,
        active: { messages: [], tools: [], delegates: [], truncated: false },
        completeThroughCursor: true,
      },
    });
    let reads = 0;
    await page.route('**/trpc/readFile*', async (route) => {
      const input = dashboardTrpcInput(route.request());
      expect(input.path).toBe('images/pixel.png');
      reads += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: trpcData({
          path: '/project/images/pixel.png',
          mediaType: 'image/png',
          base64Content: reads === 1 ? 'not an image' : pngBase64,
        }),
      });
    });
    await page.goto(`/sessions/${sessionId}`);
    const transcript = page.getByRole('region', {
      name: 'Transcript',
      exact: true,
    });
    await transcript.getByRole('link', { name: 'Open image' }).click();
    const viewer = page.getByRole('dialog').last();
    await expect(viewer.getByRole('alert')).toContainText(
      'Could not display image',
    );
    await viewer.getByRole('button', { name: 'Refresh file' }).click();
    const image = viewer.getByRole('img', { name: 'pixel.png' });
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty('naturalWidth', 1);
    expect(reads).toBe(2);
  });

  test(`SVG previews fit the viewer and do not run scripts or fetch references${suffix}`, async ({
    page,
  }, testInfo) => {
    const externalRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://example.invalid/'))
        externalRequests.push(request.url());
    });
    await page.route('https://example.invalid/**', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });
    await installDashboardBootstrap(page, snapshot, {
      sessionSnapshot: {
        entries: [
          {
            type: 'message',
            id: 'svg-links',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: '[Wide image](images/wide.svg) [Tall image](images/tall.svg)',
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
      const input = dashboardTrpcInput(route.request());
      const isWide = input.path === 'images/wide.svg';
      expect(isWide || input.path === 'images/tall.svg').toBe(true);
      const content = svg(isWide ? 4800 : 1600, isWide ? 1600 : 4800);
      await route.fulfill({
        contentType: 'application/json',
        body: trpcData({
          path: `/project/${input.path}`,
          mediaType: 'image/svg+xml',
          base64Content: Buffer.from(content).toString('base64'),
        }),
      });
    });
    await page.goto(`/sessions/${sessionId}`);
    const transcript = page.getByRole('region', {
      name: 'Transcript',
      exact: true,
    });

    for (const [label, expectedWidth, expectedHeight] of [
      ['Wide image', 4800, 1600],
      ['Tall image', 1600, 4800],
    ] as const) {
      await transcript.getByRole('link', { name: label }).click();
      const viewer = page.getByRole('dialog').last();
      const image = viewer.getByRole('img', {
        name: label === 'Wide image' ? 'wide.svg' : 'tall.svg',
      });
      await expect(image).toBeVisible();
      await expect(image).toHaveJSProperty('naturalWidth', expectedWidth);
      await expect(image).toHaveJSProperty('naturalHeight', expectedHeight);
      const dimensions = await image.evaluate((element) => {
        const imageRect = element.getBoundingClientRect();
        const preview = element.parentElement;
        if (!preview) throw new Error('Image preview has no container.');
        const previewRect = preview.getBoundingClientRect();
        return {
          imageWidth: imageRect.width,
          imageHeight: imageRect.height,
          previewWidth: previewRect.width,
          previewHeight: previewRect.height,
        };
      });
      expect(dimensions.imageWidth).toBeLessThanOrEqual(
        dimensions.previewWidth,
      );
      expect(dimensions.imageHeight).toBeLessThanOrEqual(
        dimensions.previewHeight,
      );
      expect(externalRequests).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(
          label === 'Wide image'
            ? 'wide-svg-preview.png'
            : 'tall-svg-preview.png',
        ),
      });
      await viewer.getByRole('button', { name: 'Close file viewer' }).click();
    }
  });
}
